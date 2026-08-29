// Exécuteur numérique — §2.4 de la spécification v0.1 (BR-A-18..22, BR-D-05).
//
// Un contact de confiance à qui le testateur accorde des pouvoirs additionnels,
// un par un, par cases à cocher. Aucun pouvoir n'est accordé par défaut
// (BR-A-18) — et surtout, aucun pouvoir de lecture, jamais (BR-A-20) : ce
// module n'expose aucune fonction qui retourne le contenu d'un message. Il
// supervise la mécanique, il n'accède pas au fond.

import { ajouterJours, ajouterMois } from './horloge.js';
import { consigner } from './journal.js';
import { contactsAcceptants } from './contacts.js';
import { ETATS } from './compte.js';

export const POUVOIRS = Object.freeze(['REPORT', 'SUSPENSION', 'COORDONNEES', 'JOURNAL']); // BR-A-19

const REPORT_MIN_MOIS = 1;          // BR-A-19 (a)
const REPORT_MAX_MOIS = 12;
const SUSPENSION_DELAI_H = 48;      // BR-A-22 : confirmation en deux temps
const PREAVIS_EXECUTEUR_JOURS = 7;  // BR-D-05

function noterExecuteur(compte, at, type, donnees = {}) {
  consigner(compte.journal, { at, type, donnees }, compte._hachage);
}

// BR-A-21 : tout acte de l'exécuteur est notifié aux autres contacts.
function notifierAutresContacts(compte, at, acte, donnees) {
  const autres = contactsAcceptants(compte)
    .filter((c) => !compte.executeur || c.id !== compte.executeur.contactId)
    .map((c) => c.id);
  noterExecuteur(compte, at, 'ACTE_EXECUTEUR', { acte, ...donnees, notifies: autres });
}

export function designerExecuteur(compte, { contactId, pouvoirs = {}, at }) {
  const contact = contactsAcceptants(compte).find((c) => c.id === contactId);
  if (!contact) throw new Error("l'exécuteur est un contact de confiance acceptant (BR-A-18)");
  const accordes = {};
  for (const pouvoir of POUVOIRS) accordes[pouvoir] = pouvoirs[pouvoir] === true; // rien par défaut
  compte.executeur = { contactId, pouvoirs: accordes, designeLe: at };
  noterExecuteur(compte, at, 'EXECUTEUR_DESIGNE', { contactId, pouvoirs: accordes });
  return compte.executeur;
}

export function retirerExecuteur(compte, { at }) {
  if (!compte.executeur) throw new Error('aucun exécuteur désigné');
  const { contactId } = compte.executeur;
  compte.executeur = null;
  noterExecuteur(compte, at, 'EXECUTEUR_RETIRE', { contactId });
}

function exigerPouvoir(compte, pouvoir) {
  if (!compte.executeur) throw new Error('aucun exécuteur désigné');
  if (!compte.executeur.pouvoirs[pouvoir]) {
    throw new Error(`pouvoir « ${pouvoir} » non accordé par le testateur (BR-A-18)`);
  }
  return compte.executeur;
}

// BR-D-05 : l'exécuteur au pouvoir de report est prévenu 7 jours avant le
// démarrage effectif des notifications, et peut le décaler.
export function fenetreDeReport(compte) {
  if (!compte.execution || !compte.executeur || !compte.executeur.pouvoirs.REPORT) return null;
  return {
    prevenuLe: ajouterJours(compte.execution.notificationsAt, -PREAVIS_EXECUTEUR_JOURS),
    jusquau: compte.execution.notificationsAt,
  };
}

export function reporterExecution(compte, { mois, at }) {
  exigerPouvoir(compte, 'REPORT');
  if (!compte.execution) throw new Error('aucune exécution en cours');
  if (mois < REPORT_MIN_MOIS || mois > REPORT_MAX_MOIS) {
    throw new Error(`report de ${REPORT_MIN_MOIS} à ${REPORT_MAX_MOIS} mois (BR-A-19)`);
  }
  if (compte.execution.reportePar) throw new Error('exécution déjà reportée une fois');
  if (at >= compte.execution.notificationsAt) {
    throw new Error('les notifications sont parties : plus rien ne se reporte (BR-D-01)');
  }
  const decalage = ajouterMois(compte.execution.notificationsAt, mois) - compte.execution.notificationsAt;
  compte.execution.notificationsAt += decalage;
  for (const pli of compte.execution.plis) {
    if (pli.etat === 'PLANIFIE') pli.prevuLe += decalage;
  }
  compte.execution.reportePar = { contactId: compte.executeur.contactId, at, mois };
  notifierAutresContacts(compte, at, 'REPORT', { mois, nouvellesNotificationsLe: compte.execution.notificationsAt });
  return compte.execution.notificationsAt;
}

// BR-A-22 : la suspension est le seul pouvoir destructeur. Confirmation en deux
// temps à 48 h d'intervalle, et irréversible. Le testateur a été averti de ce
// risque au moment d'accorder ce pouvoir — voir R-A-10, le conflit familial.
export function demanderSuspension(compte, { pliId, at }) {
  exigerPouvoir(compte, 'SUSPENSION');
  if (!compte.execution) throw new Error('aucune exécution en cours');
  const pli = compte.execution.plis.find((p) => p.id === pliId);
  if (!pli) throw new Error('pli introuvable');
  if (pli.etat !== 'PLANIFIE') {
    throw new Error('la suspension n’est possible qu’avant la délivrance (BR-A-19 b)');
  }
  pli.suspensionDemandee = { at, confirmableAt: at + SUSPENSION_DELAI_H * 3_600_000 };
  notifierAutresContacts(compte, at, 'SUSPENSION_DEMANDEE', {
    pli: pliId, confirmableAt: pli.suspensionDemandee.confirmableAt,
  });
  return pli.suspensionDemandee;
}

export function confirmerSuspension(compte, { pliId, at }) {
  exigerPouvoir(compte, 'SUSPENSION');
  const pli = compte.execution.plis.find((p) => p.id === pliId);
  if (!pli || !pli.suspensionDemandee) throw new Error('aucune suspension demandée');
  if (at < pli.suspensionDemandee.confirmableAt) {
    throw new Error('48 heures de réflexion avant de confirmer une suspension (BR-A-22)');
  }
  if (pli.etat !== 'PLANIFIE') throw new Error('trop tard : le pli est parti');
  pli.etat = 'SUSPENDU';
  pli.suspenduLe = at;
  for (const m of pli.messages) { m.texte = null; m.images = []; } // irréversible
  notifierAutresContacts(compte, at, 'SUSPENSION_CONFIRMEE', { pli: pliId, irreversible: true });
  return pli;
}

export function annulerSuspension(compte, { pliId, at }) {
  exigerPouvoir(compte, 'SUSPENSION');
  const pli = compte.execution.plis.find((p) => p.id === pliId);
  if (!pli || !pli.suspensionDemandee) throw new Error('aucune suspension demandée');
  if (pli.etat === 'SUSPENDU') throw new Error('la suspension est irréversible (BR-A-22)');
  pli.suspensionDemandee = null;
  notifierAutresContacts(compte, at, 'SUSPENSION_ANNULEE', { pli: pliId });
}

// BR-A-19 (c) : fournir les coordonnées manquantes d'un destinataire. L'exécuteur
// répare un canal ; il ne change pas de destinataire (BR-A-20).
export function fournirCoordonnees(compte, { pliId, email, at }) {
  exigerPouvoir(compte, 'COORDONNEES');
  const pli = compte.execution.plis.find((p) => p.id === pliId);
  if (!pli) throw new Error('pli introuvable');
  if (!['NON_DELIVRE', 'EXPIRE'].includes(pli.etat)) {
    throw new Error('coordonnées à fournir seulement sur un pli non délivré (BR-A-19 c)');
  }
  if (!email) throw new Error('adresse requise');
  const ancien = pli.canal;
  pli.destinataire = { ...pli.destinataire, email };
  pli.canal = email;
  pli.etat = 'PLANIFIE';
  pli.prevuLe = at;
  pli.rebond = false;
  pli.tentatives = 0;
  pli.prochaineTentative = null;
  pli.conservationFinAt = null;
  notifierAutresContacts(compte, at, 'COORDONNEES_FOURNIES', { pli: pliId, ancien, nouveau: email });
  return pli;
}

// BR-A-19 (d) : recevoir le journal d'exécution. Des faits et des dates —
// jamais un contenu, jamais qui a lu quoi (BR-D-12).
export function journalPourExecuteur(compte) {
  exigerPouvoir(compte, 'JOURNAL');
  const PERTINENTS = new Set([
    'EXECUTION_PLANIFIEE', 'PREAVIS_CONTACTS', 'NOTIFICATION_ENVOYEE', 'REBOND_PERMANENT',
    'NOUVELLE_TENTATIVE', 'BASCULE_SECOURS', 'NON_DELIVRE', 'LIEN_EXPIRE',
    'REFUS_DESTINATAIRE', 'ACTE_EXECUTEUR', 'EXECUTION_TERMINEE', 'PREAVIS_SUPPRESSION',
  ]);
  return compte.journal
    .filter((e) => PERTINENTS.has(e.type))
    .map((e) => ({ at: e.at, type: e.type, pli: e.donnees.pli || null }));
}

// L'état de l'exécution vu par l'exécuteur : des compteurs, pas des contenus.
export function apercuPourExecuteur(compte) {
  exigerPouvoir(compte, 'JOURNAL');
  if (!compte.execution) return null;
  const parEtat = {};
  for (const pli of compte.execution.plis) parEtat[pli.etat] = (parEtat[pli.etat] || 0) + 1;
  return { plis: compte.execution.plis.length, parEtat, etatCompte: compte.etat === ETATS.EN_EXECUTION ? 'EN_COURS' : compte.etat };
}
