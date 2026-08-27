// Cycle de vie des données — module E de la spécification v0.1 (§6).
//
// La spec distingue quatre ensembles au sort différent, et c'est tout l'objet
// de ce module : supprimer sans jamais détruire ce qui doit survivre.
//
//   E1  compte et contenus privés   supprimés 90 j après la fin de l'exécution
//   E2  messages différés en attente  conservés jusqu'à leur date, forme minimale
//   E3  messages publics             selon la directive du testateur, de son vivant
//   E4  journal d'exécution          faits et dates, sans contenu, 5 ans
//
// Les suppressions sont définitives et irréversibles (BR-E-01) : rien ici ne
// sait revenir en arrière.

import { ajouterJours, ajouterMois } from './horloge.js';
import { consigner, tronquerJournal } from './journal.js';
import { contactsAcceptants } from './contacts.js';
import { ETATS } from './compte.js';

export const DIRECTIVES_PUBLIQUES = Object.freeze([
  'RETRAIT_AVEC_COMPTE',   // défaut — aucun choix par défaut vers l'archive (BR-E-03)
  'ARCHIVE_ATTRIBUEE',
  'ARCHIVE_ANONYMISEE',
]);

const PREAVIS_SUPPRESSION_JOURS = 15;   // BR-E-02
const CONSERVATION_DIFFERE_MOIS = 12;   // E2 : 12 mois après la date de délivrance
const CONSERVATION_JOURNAL_ANS = 5;     // BR-E-05
const RETRACTATION_HEURES = 72;         // BR-A-06, repris par BR-E-06
const PURGE_SAUVEGARDES_JOURS = 35;     // BR-E-09
const INACTIF_NON_ARME_MOIS = 24;       // BR-E-10
const RELANCES_AVANT_SUPPRESSION = 3;   // BR-E-10

function noterDonnees(compte, at, type, donnees = {}) {
  consigner(compte.journal, { at, type, donnees }, compte._hachage);
}

function magasin(compte) {
  // E2 vit dans un magasin distinct, avec sa propre politique de rétention :
  // un bug qui supprimerait E1 ne doit pas emporter les messages différés (R-E-1).
  if (!compte.magasinDiffere) compte.magasinDiffere = [];
  return compte.magasinDiffere;
}

function archive(compte) {
  if (!compte.archivePublique) compte.archivePublique = [];
  return compte.archivePublique;
}

// BR-E-04 : un texte qui reste identifiant par lui-même ne peut pas être
// anonymisé — il est refusé à l'archive anonyme plutôt que faussement anonymisé.
const MARQUEURS_IDENTIFIANTS = [
  /\bmoi,\s+[a-zà-ÿ'’-]+\s+de\s+[A-ZÀ-Ý]/i,   // « moi, maire de X »
  /\bje\s+m['’]appelle\s+[A-ZÀ-Ý]/,
  /\bje\s+suis\s+(le|la)\s+\w+\s+de\s+[A-ZÀ-Ý]/,
];

export function resteIdentifiant(texte) {
  return MARQUEURS_IDENTIFIANTS.some((m) => m.test(texte || ''));
}

// Directive post-mortem pour un message public, choisie du vivant (BR-E-03).
export function definirDirectivePublique(msg, directive) {
  if (!DIRECTIVES_PUBLIQUES.includes(directive)) {
    throw new Error(`directive parmi : ${DIRECTIVES_PUBLIQUES.join(', ')} (BR-E-03)`);
  }
  if (directive === 'ARCHIVE_ANONYMISEE' && resteIdentifiant(msg.travail.texte)) {
    throw new Error('ce texte reste identifiant par lui-même : archive anonyme refusée (BR-E-04)');
  }
  msg.travail.directivePublique = directive;
}

export function directiveDe(msg) {
  const v = msg.versions.length ? msg.versions[msg.versions.length - 1] : null;
  return (v && v.directivePublique) || msg.travail.directivePublique || 'RETRAIT_AVEC_COMPTE';
}

// Met à l'abri les messages différés avant toute suppression de compte : forme
// minimale, contenu + destinataire + date, rien d'autre (BR-B-20).
function mettreAuMagasin(compte, messages, at) {
  const m = magasin(compte);
  for (const msg of messages) {
    const v = msg.versions.length ? msg.versions[msg.versions.length - 1] : null;
    if (!v || v.visibilite === 'PUBLIC') continue;
    if (v.delivrance.mode !== 'DATE_FIXE') continue;
    if (v.delivrance.dateFixe <= at) continue;      // déjà dû : c'est l'affaire du module D
    if (m.some((e) => e.messageId === msg.id)) continue;
    m.push({
      messageId: msg.id,
      texte: v.texte,
      images: v.images,
      destinataires: v.destinataires.map((d) => ({ prenomNom: d.prenomNom, email: d.email, langue: d.langue })),
      dateFixe: v.delivrance.dateFixe,
      conservationFinAt: ajouterMois(v.delivrance.dateFixe, CONSERVATION_DIFFERE_MOIS),
    });
    noterDonnees(compte, at, 'E2_MIS_AU_MAGASIN', { message: msg.id, dateFixe: v.delivrance.dateFixe });
  }
}

// Applique les directives publiques au moment de la suppression du compte (BR-E-03).
function traiterPublics(compte, at) {
  const enLigne = (compte.publications || []).filter((p) => p.etat === 'PUBLIEE');
  for (const p of enLigne) {
    const directive = p.directive || 'RETRAIT_AVEC_COMPTE';
    if (directive === 'RETRAIT_AVEC_COMPTE') {
      p.etat = 'RETIREE';
      p.retireeLe = at;
      noterDonnees(compte, at, 'E3_RETIREE', { message: p.messageId });
      continue;
    }
    const anonyme = directive === 'ARCHIVE_ANONYMISEE';
    if (anonyme && resteIdentifiant(p.texte)) {
      p.etat = 'RETIREE';
      p.retireeLe = at;
      noterDonnees(compte, at, 'E3_ARCHIVE_REFUSEE', { message: p.messageId, motif: 'TEXTE_IDENTIFIANT' });
      continue;
    }
    archive(compte).push({
      messageId: p.messageId,
      texte: p.texte,
      // L'anonymisation est irréversible : ni nom, ni identifiant technique,
      // ni métadonnée permettant de remonter au compte (BR-E-04).
      attribution: anonyme ? 'ANONYME' : p.attribution,
      auteurConserve: !anonyme,
      archiveeLe: at,
    });
    p.etat = 'ARCHIVEE';
    noterDonnees(compte, at, 'E3_ARCHIVEE', { message: p.messageId, directive, anonymisee: anonyme });
  }
}

// Purge E1 : profil, brouillons, messages délivrés, médias, préférences.
// Définitive et irréversible (BR-E-01).
function purgerE1(compte, messages, at) {
  mettreAuMagasin(compte, messages, at);
  traiterPublics(compte, at);
  for (const msg of messages) {
    msg.travail = { texte: null, images: [], note: null, destinataires: [], secours: null,
      delivrance: { mode: 'IMMEDIATE', dateFixe: null }, visibilite: 'PRIVE',
      autorisationPublique: null, publication: { mode: 'A_EXECUTION', dateFixe: null } };
    msg.versions = [];
    msg.etat = 'SUPPRIME'; // il n'est plus scellé : il n'existe plus
    msg.purgeLe = at;
  }
  if (compte.execution) {
    for (const pli of compte.execution.plis) {
      for (const m of pli.messages) { m.texte = null; m.images = []; m.note = null; }
    }
  }
  compte.contacts = [];
  compte.attestations = [];
  compte.purgeE1 = { at, sauvegardesPurgeesAvant: ajouterJours(at, PURGE_SAUVEGARDES_JOURS) };
  noterDonnees(compte, at, 'E1_SUPPRIME', {
    definitif: true,
    messagesDifferesConserves: magasin(compte).length,
    publicsArchives: archive(compte).length,
    sauvegardesPurgeesAvant: compte.purgeE1.sauvegardesPurgeesAvant, // BR-E-09
  });
}

// Moteur du cycle de vie. À appeler après tick() et tickExecution().
export function tickDonnees(compte, messages, at) {
  const avant = compte.journal.length;

  // BR-E-02 : quinze jours avant la suppression, les contacts de confiance et
  // l'exécuteur sont prévenus, et peuvent télécharger ce à quoi ils ont droit.
  // Volontairement indépendant de l'état courant : si le temps a sauté par-dessus
  // la fenêtre, le préavis reste dû et se journalise à sa date d'échéance. Une
  // obligation d'information ne disparaît pas parce qu'on l'a constatée en retard.
  if (compte.liquidation && !compte.preavisSuppression) {
    const quand = ajouterJours(compte.liquidation.finAt, -PREAVIS_SUPPRESSION_JOURS);
    if (at >= quand) {
      compte.preavisSuppression = { at: quand, constateLe: at };
      noterDonnees(compte, quand, 'PREAVIS_SUPPRESSION', {
        contacts: contactsAcceptants(compte).map((c) => c.id),
        suppressionLe: compte.liquidation.finAt,
        telechargementOuvert: true,
      });
    }
  }

  // Suppression effective de E1 dès que le compte passe à SUPPRIME.
  if (compte.etat === ETATS.SUPPRIME && !compte.purgeE1) {
    purgerE1(compte, messages, at);
  }

  // E2 : un message différé arrivé à échéance quitte le magasin ; passé sa
  // fenêtre de conservation, il est détruit.
  for (const entree of [...magasin(compte)]) {
    if (at >= entree.conservationFinAt) {
      const index = magasin(compte).indexOf(entree);
      magasin(compte).splice(index, 1);
      noterDonnees(compte, at, 'E2_SUPPRIME', { message: entree.messageId });
    }
  }

  // BR-E-05 : le journal ne contient jamais de contenu ; il est conservé cinq
  // ans, puis tronqué — la troncature elle-même est journalisée et ancrée.
  const limite = ajouterMois(at, -CONSERVATION_JOURNAL_ANS * 12);
  if (compte.journal.length && compte.journal[0].at < limite) {
    tronquerJournal(compte.journal, { avantLe: limite, at }, compte._hachage);
  }

  // BR-E-06 : suppression volontaire, après le délai de rétractation de 72 h.
  if (compte.suppressionDemandee && at >= compte.suppressionDemandee.effectiveAt) {
    const demande = compte.suppressionDemandee;
    compte.suppressionDemandee = null;
    compte.etat = ETATS.SUPPRIME;
    noterDonnees(compte, at, 'SUPPRESSION_VOLONTAIRE_EXECUTEE', { demandeeLe: demande.at });
    purgerE1(compte, messages, at);
  }

  // BR-E-10 : un compte jamais armé et inactif depuis 24 mois n'a rien à
  // délivrer — trois relances, puis suppression.
  if (compte.etat === ETATS.NOUVEAU || compte.etat === ETATS.DESARME) {
    const base = compte.derniereS1 || compte.creeLe;
    if (at >= ajouterMois(base, INACTIF_NON_ARME_MOIS)) {
      compte.relancesInactif = compte.relancesInactif || 0;
      if (compte.relancesInactif < RELANCES_AVANT_SUPPRESSION) {
        compte.relancesInactif += 1;
        noterDonnees(compte, at, 'RELANCE_COMPTE_INACTIF', { numero: compte.relancesInactif });
      } else {
        compte.etat = ETATS.SUPPRIME;
        noterDonnees(compte, at, 'COMPTE_INACTIF_SUPPRIME', { motif: '24 mois sans armement' });
        purgerE1(compte, messages, at);
      }
    }
  }

  return compte.journal.slice(avant);
}

// BR-E-06 : suppression à tout moment de son vivant, avec rétractation de 72 h.
export function demanderSuppressionCompte(compte, { at, auth = {} }) {
  if (auth.deuxFacteurs !== true) throw new Error('suppression de compte : 2FA requise (BR-A-06)');
  if (compte.etat === ETATS.SUPPRIME) throw new Error('compte déjà supprimé');
  if ([ETATS.EN_EXECUTION, ETATS.EN_LIQUIDATION].includes(compte.etat)) {
    throw new Error("l'exécution est en cours : elle est irréversible (BR-D-01)");
  }
  compte.suppressionDemandee = { at, effectiveAt: at + RETRACTATION_HEURES * 3_600_000 };
  noterDonnees(compte, at, 'SUPPRESSION_DEMANDEE', {
    effectiveAt: compte.suppressionDemandee.effectiveAt,
    canauxNotifies: ['email', 'email2', 'push', 'sms'],
  });
  return compte.suppressionDemandee;
}

export function annulerSuppressionCompte(compte, { at }) {
  if (!compte.suppressionDemandee) throw new Error('aucune suppression en attente');
  compte.suppressionDemandee = null;
  noterDonnees(compte, at, 'SUPPRESSION_ANNULEE', {});
}

// BR-E-07 : export complet, dans un format ouvert et lisible sans le service.
// Le noyau produit la structure ; l'enrobage en archive ZIP appartient à
// l'infrastructure.
export function exporter(compte, messages, at) {
  const fichiers = [];
  for (const msg of messages) {
    const v = msg.versions.length ? msg.versions[msg.versions.length - 1] : null;
    const corps = v ? v.texte : msg.travail.texte;
    if (corps == null) continue;
    fichiers.push({
      chemin: `messages/${msg.id}.txt`,
      contenu: corps,
    });
    fichiers.push({
      chemin: `messages/${msg.id}.html`,
      contenu: `<!doctype html><meta charset="utf-8"><title>${msg.titre}</title>`
        + `<pre style="font:16px/1.7 Georgia,serif;white-space:pre-wrap">${corps}</pre>`,
    });
  }
  const index = {
    compte: compte.id,
    exporteLe: at,
    etat: compte.etat,
    messages: messages.map((msg) => {
      const v = msg.versions.length ? msg.versions[msg.versions.length - 1] : null;
      return {
        id: msg.id,
        titre: msg.titre,
        etat: msg.etat,
        versions: msg.versions.length,
        scelleLe: v ? v.scelleLe : null,
        visibilite: v ? v.visibilite : msg.travail.visibilite,
        destinataires: (v ? v.destinataires : msg.travail.destinataires)
          .map((d) => ({ prenomNom: d.prenomNom, email: d.email })),
        delivrance: v ? v.delivrance : msg.travail.delivrance,
      };
    }),
    contacts: compte.contacts.map((c) => ({ nom: c.nom, email: c.email, statut: c.statut })),
    journal: compte.journal.map((e) => ({ at: e.at, type: e.type, donnees: e.donnees })),
    messagesDifferes: magasin(compte).length,
    archivePublique: archive(compte).length,
  };
  fichiers.push({ chemin: 'index.json', contenu: JSON.stringify(index, null, 2) });
  return { index, fichiers };
}

// BR-E-08 : le destinataire a les mêmes droits sur ses propres données.
export function exporterPourDestinataire(compte, { email }) {
  const plis = compte.execution
    ? compte.execution.plis.filter((p) => p.destinataire && p.destinataire.email === email)
    : [];
  return {
    destinataire: email,
    plis: plis.map((p) => ({
      pli: p.id,
      notifieLe: p.notifieLe,
      etat: p.etat,
      messages: p.messages.map((m) => ({ texte: m.texte, note: m.note })),
    })),
    journal: compte.journal
      .filter((e) => plis.some((p) => e.donnees && e.donnees.pli === p.id))
      .map((e) => ({ at: e.at, type: e.type })),
  };
}

// Vue de conservation : ce qui reste, et jusqu'à quand.
export function etatConservation(compte, at) {
  return {
    e1: compte.purgeE1
      ? { statut: 'SUPPRIME', le: compte.purgeE1.at, sauvegardesPurgeesAvant: compte.purgeE1.sauvegardesPurgeesAvant }
      : { statut: 'PRESENT', suppressionLe: compte.liquidation ? compte.liquidation.finAt : null },
    e2: magasin(compte).map((e) => ({
      message: e.messageId, dateFixe: e.dateFixe, conservationFinAt: e.conservationFinAt,
    })),
    e3: archive(compte).map((e) => ({ message: e.messageId, attribution: e.attribution })),
    e4: {
      entrees: compte.journal.length,
      plusAncienne: compte.journal.length ? compte.journal[0].at : null,
      troncatureAvant: ajouterMois(at, -CONSERVATION_JOURNAL_ANS * 12),
    },
    suppressionDemandee: compte.suppressionDemandee,
  };
}
