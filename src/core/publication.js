// Publication publique — §5.3 de la spécification v0.1.
//
// Deux différences majeures avec la délivrance privée :
//   • une publication peut être programmée à une date fixe, y compris **du
//     vivant du testateur** (BR-B-18 ; le §7.4 évoque explicitement le cas d'un
//     « message public d'un testateur encore vivant ») ;
//   • rien n'est jamais publié automatiquement : tout message public passe par
//     une revue humaine préalable, sans exception (BR-D-15). Ce module ne sait
//     donc que *soumettre* à modération — publier exige une décision humaine.

import { ajouterJours } from './horloge.js';
import { consigner } from './journal.js';
import { contactsAcceptants } from './contacts.js';
import { ETATS } from './compte.js';

export const ETATS_PUBLICATION = Object.freeze({
  EN_MODERATION: 'EN_MODERATION',
  PUBLIEE: 'PUBLIEE',
  REFUSEE: 'REFUSEE',
  RETIREE: 'RETIREE',
});

const DELAI_MODERATION_JOURS = 7;   // BR-D-16 : objectif annoncé au testateur
const RETRAIT_TIERS_HEURES = 72;    // BR-D-20 : demandes traitées en priorité
const PUBLICS_MAX = 5;              // R-D-8 : plafond par compte

function noterPublication(compte, at, type, donnees = {}) {
  consigner(compte.journal, { at, type, donnees }, compte._hachage);
}

function registre(compte) {
  if (!compte.publications) compte.publications = [];
  return compte.publications;
}

function derniereVersion(msg) {
  return msg.versions.length ? msg.versions[msg.versions.length - 1] : null;
}

export function estPublic(msg) {
  const v = derniereVersion(msg);
  return Boolean(v && v.visibilite === 'PUBLIC');
}

// Date à laquelle la publication devient due. Une date fixe peut tomber du
// vivant du testateur ; « à l'exécution » attend la mort présumée.
export function dateDuePublication(compte, msg) {
  const v = derniereVersion(msg);
  if (!v || v.visibilite !== 'PUBLIC') return null;
  if (v.publication.mode === 'DATE_FIXE') {
    return Math.max(v.publication.dateFixe, v.executableAt); // BR-B-09
  }
  if (!compte.execution) return null; // pas encore d'exécution : rien n'est dû
  return Math.max(compte.execution.demarreeLe, v.executableAt);
}

// Soumet à la file de modération les publications échues. Ne publie jamais.
export function tickPublications(compte, messages, at) {
  const avant = compte.journal.length;
  const reg = registre(compte);
  for (const msg of messages) {
    if (!estPublic(msg)) continue;
    const v = derniereVersion(msg);
    const entree = reg.find((p) => p.messageId === msg.id);
    if (entree && entree.version === v.numero) continue; // déjà en file ou traitée
    const due = dateDuePublication(compte, msg);
    if (due == null || at < due) continue;
    if (reg.filter((p) => p.etat === ETATS_PUBLICATION.PUBLIEE).length >= PUBLICS_MAX) {
      noterPublication(compte, at, 'PUBLICATION_PLAFONNEE', { message: msg.id, plafond: PUBLICS_MAX });
      continue;
    }
    const nouvelle = {
      messageId: msg.id,
      version: v.numero,
      etat: ETATS_PUBLICATION.EN_MODERATION,
      dueLe: due,
      soumiseLe: at,
      decisionAvant: ajouterJours(at, DELAI_MODERATION_JOURS), // BR-D-16
      duVivant: compte.etat !== ETATS.EN_EXECUTION && compte.etat !== ETATS.EXECUTE
        && compte.etat !== ETATS.EN_LIQUIDATION && compte.etat !== ETATS.SUPPRIME,
      attribution: v.autorisationPublique.attribution,
      indexable: v.autorisationPublique.indexable,
      directive: v.directivePublique || 'RETRAIT_AVEC_COMPTE', // BR-E-03
      texte: v.texte,
      titreInterne: msg.titre, // jamais publié — utile au seul modérateur
      publieeLe: null,
      motifRefus: null,
      retireeLe: null,
    };
    if (entree) Object.assign(entree, nouvelle);
    else reg.push(nouvelle);
    noterPublication(compte, at, 'PUBLICATION_SOUMISE_MODERATION', {
      message: msg.id, version: v.numero, duVivant: nouvelle.duVivant,
      decisionAvant: nouvelle.decisionAvant,
    });
  }
  return compte.journal.slice(avant);
}

export function fileModeration(compte) {
  return registre(compte).filter((p) => p.etat === ETATS_PUBLICATION.EN_MODERATION);
}

export function publicationsEnLigne(compte) {
  return registre(compte).filter((p) => p.etat === ETATS_PUBLICATION.PUBLIEE);
}

// Décision humaine, toujours motivée et notifiée (BR-D-15, BR-M-03).
export function deciderModeration(compte, { messageId, decision, motif = null, moderateur, at }) {
  const p = registre(compte).find((x) => x.messageId === messageId && x.etat === ETATS_PUBLICATION.EN_MODERATION);
  if (!p) throw new Error('aucune publication en attente de modération pour ce message');
  if (!moderateur) throw new Error('toute décision de modération est nominative (BR-M-03, PD-7)');
  if (decision === 'ACCEPTE') {
    p.etat = ETATS_PUBLICATION.PUBLIEE;
    p.publieeLe = at;
    noterPublication(compte, at, 'PUBLICATION_EN_LIGNE', {
      message: messageId, moderateur, attribution: p.attribution,
      indexable: p.indexable, duVivant: p.duVivant, delaiJours: Math.round((at - p.soumiseLe) / 86400000),
    });
    return p;
  }
  if (decision !== 'REFUSE') throw new Error('décision : ACCEPTE ou REFUSE');
  if (!motif) throw new Error('un refus de modération est toujours motivé (BR-M-03)');
  p.etat = ETATS_PUBLICATION.REFUSEE;
  p.motifRefus = motif;
  // BR-D-17 : un public refusé n'est jamais supprimé en silence — il bascule en
  // message privé vers les contacts de confiance, avec le motif.
  const destinataires = contactsAcceptants(compte).map((c) => c.id);
  noterPublication(compte, at, 'PUBLICATION_REFUSEE', { message: messageId, moderateur, motif });
  noterPublication(compte, at, 'BASCULE_PRIVE_CONTACTS', { message: messageId, contacts: destinataires, motif });
  return p;
}

// §7.4 : un modérateur qui identifie une détresse dans le message d'un
// testateur ENCORE VIVANT ne fait pas de la modération, il déclenche une aide.
export function signalerDetresse(compte, { messageId, moderateur, at }) {
  const p = registre(compte).find((x) => x.messageId === messageId);
  if (!p) throw new Error('publication inconnue');
  if (!p.duVivant) {
    throw new Error("le testateur n'est plus là : seule la protection des destinataires s'applique (§7.4)");
  }
  noterPublication(compte, at, 'ALERTE_DETRESSE', {
    message: messageId, moderateur,
    action: 'RESSOURCES_AIDE_PRESENTEES_AU_TESTATEUR',
  });
}

// BR-D-20 : toute personne mentionnée peut demander le retrait ou
// l'anonymisation ; traitement prioritaire, objectif 72 h. L'auteur vivant peut
// lui aussi retirer sa propre publication — écart assumé, la spec ne le prévoit
// pas explicitement mais l'inverse serait absurde.
export function demanderRetrait(compte, { messageId, par, motif, at }) {
  const p = registre(compte).find((x) => x.messageId === messageId && x.etat === ETATS_PUBLICATION.PUBLIEE);
  if (!p) throw new Error('aucune publication en ligne pour ce message');
  p.retrait = { par, motif, demandeLe: at, traiterAvant: at + RETRAIT_TIERS_HEURES * 3_600_000 };
  noterPublication(compte, at, 'RETRAIT_DEMANDE', { message: messageId, par, motif, traiterAvant: p.retrait.traiterAvant });
  return p.retrait;
}

export function retirerPublication(compte, { messageId, par, motif = null, at }) {
  const p = registre(compte).find((x) => x.messageId === messageId && x.etat === ETATS_PUBLICATION.PUBLIEE);
  if (!p) throw new Error('aucune publication en ligne pour ce message');
  p.etat = ETATS_PUBLICATION.RETIREE;
  p.retireeLe = at;
  p.motifRetrait = motif || (p.retrait ? p.retrait.motif : null);
  noterPublication(compte, at, 'PUBLICATION_RETIREE', { message: messageId, par, motif: p.motifRetrait });
  return p;
}

// Ce que voit le public : jamais le titre interne, jamais l'identité si
// l'attribution ne l'autorise pas (BR-D-18), et indexable seulement sur
// autorisation distincte (BR-D-19).
export function vuePublique(p, profil = {}) {
  const nom = {
    NOM_COMPLET: profil.nomComplet || profil.nomAffichage || null,
    PRENOM: profil.prenom || (profil.nomAffichage || '').split(' ')[0] || null,
    PSEUDONYME: profil.pseudonyme || profil.nomAffichage || null,
    ANONYME: null,
  }[p.attribution];
  return {
    texte: p.texte,
    auteur: nom,
    anonyme: p.attribution === 'ANONYME',
    publieeLe: p.publieeLe,
    indexable: p.indexable,
    duVivant: p.duVivant,
  };
}
