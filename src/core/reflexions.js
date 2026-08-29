// Réflexions publiques — §5.3 de la spécification v0.1.
//
// Ce qu'on dépose sous le message d'un mort. Quatre garde-fous, tous dans la
// spec, et le quatrième est le plus important :
//   • modération a priori, sans exception au lancement (BR-D-21) ;
//   • compte vérifié obligatoire, aucun dépôt anonyme (BR-D-22) ;
//   • le testateur peut les désactiver par avance, message par message (BR-D-23) ;
//   • aucun mécanisme d'engagement : ni compteur de vues, ni « j'aime », ni
//     classement, ni fil, ni recommandation (BR-D-24). Le produit ne doit pas
//     transformer le deuil en métrique — c'est pourquoi la vue publique ci-dessous
//     n'expose aucun nombre.

import { consigner } from './journal.js';

export const ETATS_REFLEXION = Object.freeze({
  EN_MODERATION: 'EN_MODERATION',
  PUBLIEE: 'PUBLIEE',
  REJETEE: 'REJETEE',
  RETIREE: 'RETIREE',
});

// BR-D-25 : signalement en un clic ; 24 h pour les catégories graves.
export const CATEGORIES_SIGNALEMENT = Object.freeze([
  'HAINE', 'HARCELEMENT', 'CONTENU_ILLICITE', 'ATTEINTE_VIE_PRIVEE', 'AUTRE',
]);
const CATEGORIES_GRAVES = new Set(['HAINE', 'HARCELEMENT', 'CONTENU_ILLICITE']);
const DELAI_GRAVE_H = 24;
const DELAI_ORDINAIRE_H = 72;
const REFLEXION_MAX = 2000;

function noterReflexion(compte, at, type, donnees = {}) {
  consigner(compte.journal, { at, type, donnees }, compte._hachage);
}

function registre(compte) {
  if (!compte.reflexions) compte.reflexions = [];
  return compte.reflexions;
}

function publicationEnLigne(compte, messageId) {
  return (compte.publications || []).find(
    (p) => p.messageId === messageId && p.etat === 'PUBLIEE');
}

// BR-D-22 : déposer exige un compte vérifié. Le noyau ne sait pas vérifier un
// compte — il exige que l'appelant l'atteste, et le journalise.
export function deposerReflexion(compte, { messageId, auteur, texte, at }) {
  const publication = publicationEnLigne(compte, messageId);
  if (!publication) throw new Error('aucun message public en ligne sous ce numéro');
  if (publication.reflexionsDesactivees) {
    throw new Error("l'auteur a désactivé les réflexions sous ce message (BR-D-23)");
  }
  if (!auteur || auteur.compteVerifie !== true) {
    throw new Error('déposer une réflexion exige un compte vérifié — aucun dépôt anonyme (BR-D-22)');
  }
  if (!texte || !texte.trim()) throw new Error('réflexion vide');
  if (texte.length > REFLEXION_MAX) throw new Error(`réflexion limitée à ${REFLEXION_MAX} caractères`);

  const reflexion = {
    id: `r${registre(compte).length + 1}`,
    messageId,
    auteur: { id: auteur.id, pseudo: auteur.pseudo || null }, // jamais l'email
    texte,
    deposeeLe: at,
    etat: ETATS_REFLEXION.EN_MODERATION, // BR-D-21 : jamais publiée d'emblée
    signalements: [],
  };
  registre(compte).push(reflexion);
  noterReflexion(compte, at, 'REFLEXION_DEPOSEE', {
    reflexion: reflexion.id, message: messageId, auteur: auteur.id,
  });
  return reflexion;
}

// Décision humaine, nominative, motivée en cas de rejet (BR-M-03).
export function modererReflexion(compte, { reflexionId, decision, motif = null, moderateur, at }) {
  const r = registre(compte).find((x) => x.id === reflexionId);
  if (!r) throw new Error('réflexion introuvable');
  if (r.etat !== ETATS_REFLEXION.EN_MODERATION) throw new Error('réflexion déjà tranchée');
  if (!moderateur) throw new Error('toute décision de modération est nominative (BR-M-03)');
  if (decision === 'ACCEPTE') {
    r.etat = ETATS_REFLEXION.PUBLIEE;
    r.publieeLe = at;
    noterReflexion(compte, at, 'REFLEXION_PUBLIEE', { reflexion: r.id, moderateur });
    return r;
  }
  if (decision !== 'REJETE') throw new Error('décision : ACCEPTE ou REJETE');
  if (!motif) throw new Error('un rejet est toujours motivé (BR-M-03)');
  r.etat = ETATS_REFLEXION.REJETEE;
  r.motif = motif;
  noterReflexion(compte, at, 'REFLEXION_REJETEE', { reflexion: r.id, moderateur, motif });
  return r;
}

// BR-D-25 : signalement en un clic, sur une réflexion comme sur un message
// public. Les catégories graves sont traitées en 24 h.
export function signalerContenu(compte, { cible, id, categorie, par, at }) {
  if (!['REFLEXION', 'PUBLICATION'].includes(cible)) throw new Error('cible : REFLEXION ou PUBLICATION');
  if (!CATEGORIES_SIGNALEMENT.includes(categorie)) {
    throw new Error(`catégorie parmi : ${CATEGORIES_SIGNALEMENT.join(', ')}`);
  }
  const grave = CATEGORIES_GRAVES.has(categorie);
  const signalement = {
    categorie,
    par: par || 'anonyme',
    at,
    grave,
    traiterAvant: at + (grave ? DELAI_GRAVE_H : DELAI_ORDINAIRE_H) * 3_600_000,
  };
  const cibleObjet = cible === 'REFLEXION'
    ? registre(compte).find((x) => x.id === id)
    : (compte.publications || []).find((p) => p.messageId === id);
  if (!cibleObjet) throw new Error('contenu signalé introuvable');
  if (!cibleObjet.signalements) cibleObjet.signalements = [];
  cibleObjet.signalements.push(signalement);
  noterReflexion(compte, at, 'SIGNALEMENT', {
    cible, id, categorie, grave, traiterAvant: signalement.traiterAvant,
  });
  return signalement;
}

// File des signalements en attente, les graves d'abord (BR-D-25).
export function fileSignalements(compte) {
  const entrees = [];
  for (const r of registre(compte)) {
    for (const s of r.signalements || []) {
      if (!s.traiteLe) entrees.push({ cible: 'REFLEXION', id: r.id, ...s });
    }
  }
  for (const p of compte.publications || []) {
    for (const s of p.signalements || []) {
      if (!s.traiteLe) entrees.push({ cible: 'PUBLICATION', id: p.messageId, ...s });
    }
  }
  return entrees.sort((a, b) => (b.grave - a.grave) || (a.traiterAvant - b.traiterAvant));
}

export function traiterSignalement(compte, { cible, id, retirer, moderateur, motif = null, at }) {
  if (!moderateur) throw new Error('traitement nominatif (BR-M-03)');
  const objet = cible === 'REFLEXION'
    ? registre(compte).find((x) => x.id === id)
    : (compte.publications || []).find((p) => p.messageId === id);
  if (!objet) throw new Error('contenu introuvable');
  for (const s of objet.signalements || []) { if (!s.traiteLe) s.traiteLe = at; }
  if (retirer) {
    objet.etat = 'RETIREE';
    objet.retireeLe = at;
    if (!motif) throw new Error('un retrait est toujours motivé (BR-M-03)');
    objet.motif = motif;
  }
  noterReflexion(compte, at, 'SIGNALEMENT_TRAITE', { cible, id, retire: Boolean(retirer), moderateur, motif });
  return objet;
}

// BR-D-23 : le testateur désactive les réflexions par avance, message par
// message. Après l'exécution, le réglage est définitif — plus personne n'a
// qualité pour en décider à sa place.
export function definirReflexions(compte, { messageId, actives, executionCommencee = false }) {
  const p = (compte.publications || []).find((x) => x.messageId === messageId);
  if (!p) throw new Error('publication inconnue');
  if (executionCommencee) {
    throw new Error('réglage définitif après exécution : il ne peut plus changer (BR-D-23)');
  }
  p.reflexionsDesactivees = !actives;
  return p;
}

// Vue publique. Aucun nombre : ni vues, ni « j'aime », ni classement, ni rang
// (BR-D-24). L'ordre est chronologique, point.
export function reflexionsPubliques(compte, messageId) {
  return registre(compte)
    .filter((r) => r.messageId === messageId && r.etat === ETATS_REFLEXION.PUBLIEE)
    .sort((a, b) => a.publieeLe - b.publieeLe)
    .map((r) => ({ texte: r.texte, auteur: r.auteur.pseudo, publieeLe: r.publieeLe }));
}

export function fileModerationReflexions(compte) {
  return registre(compte).filter((r) => r.etat === ETATS_REFLEXION.EN_MODERATION);
}
