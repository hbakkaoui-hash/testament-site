// Exécution posthume — module D de la spécification v0.1 (§5.1 et 5.2).
// L'exécution est irréversible (BR-D-01) : ce module ne connaît aucune façon
// de l'annuler. Il produit des « plis » — un pli = un destinataire, une vague,
// l'ensemble de ses messages (BR-D-03) — et gère leur cycle de vie.
//
// Deux principes de la spec sont encodés en négatif, et méritent d'être dits :
//   • aucune relance n'est envoyée à un destinataire qui n'ouvre pas (§7.3) ;
//     les seules nouvelles tentatives sont techniques, sur rebond (BR-D-07) ;
//   • aucun contenu de message ne part dans une notification (BR-D-08) :
//     contenuNotification() ne retourne que l'existence d'un pli.

import { ajouterJours, ajouterMois } from './horloge.js';
import { consigner } from './journal.js';
import { pourExecution } from './message.js';
import { ETATS } from './compte.js';

export const ETATS_PLI = Object.freeze({
  PLANIFIE: 'PLANIFIE',
  NOTIFIE: 'NOTIFIE',          // notification partie, sas pas encore ouvert
  SAS_OUVERT: 'SAS_OUVERT',    // le destinataire a vu la page d'atterrissage
  LU: 'LU',
  REFUSE: 'REFUSE',            // BR-D-11
  NON_DELIVRE: 'NON_DELIVRE',  // BR-D-07
  EXPIRE: 'EXPIRE',            // lien de 12 mois échu sans ouverture (BR-D-09)
  EFFACE: 'EFFACE',            // fin de conservation
});

const PREAVIS_CONTACTS_JOURS = 7;      // A-7 / R-D-1 : les vivants avant les endeuillés
const ETALEMENT_VAGUE_H = 72;          // BR-D-02
const TENTATIVES_MAX = 3;              // BR-D-07
const TENTATIVE_PAS_JOURS = 10;        // 3 nouvelles tentatives sur 30 jours
const LIEN_VALIDITE_MOIS = 12;         // BR-D-09
const CONSERVATION_MOIS = 12;          // BR-D-07, BR-D-11, §5.2 point 4
const REFLEXION_FORT_IMPACT_H = 24;    // BR-D-13
const CODE_VALIDITE_MIN = 15;          // code à usage unique du sas (§5.2 point 3)
const RAPPELS_AUTORISES_MOIS = [1, 3, 6]; // sas : « Plus tard »
const HEURE = 3_600_000;

function noterExecution(compte, at, type, donnees = {}) {
  consigner(compte.journal, { at, type, donnees }, compte._hachage);
}

function nature(version) {
  return {
    texte: version.texte.trim().length > 0,
    images: version.images.length,
    fortImpact: version.fortImpact, // BR-B-08 → sas renforcé (BR-D-13)
  };
}

function creerPli({ id, destinataire, entrees, type, prevuLe }) {
  return {
    id,
    type,
    destinataire: { ...destinataire },
    messages: entrees.map(({ message, version }) => ({
      messageId: message.id,
      version: version.numero,
      dateMessage: message.creeLe,
      derniereModif: version.scelleLe, // affichée au sas (R-B-1)
      note: version.note,              // BR-B-07
      nature: nature(version),
      texte: version.texte,            // jamais exposé avant lecture vérifiée
      images: version.images,
      secours: version.secours,
    })),
    etat: ETATS_PLI.PLANIFIE,
    prevuLe,
    notifieLe: null,
    lienExpireLe: null,
    canal: destinataire.email,
    secoursUtilise: false,
    tentatives: 0,
    rebond: false,
    prochaineTentative: null,
    sasOuvertLe: null,
    reflexionFinAt: null,
    code: null,
    codeVerifieLe: null,
    luLe: null,
    telechargeLe: null,
    refuseLe: null,
    rappelLe: null,
    conservationFinAt: null,
  };
}

function trouverPli(compte, pliId) {
  if (!compte.execution) throw new Error('aucune exécution en cours');
  const pli = compte.execution.plis.find((p) => p.id === pliId);
  if (!pli) throw new Error('pli introuvable');
  return pli;
}

// Démarre l'exécution : construit les plis et fixe le préavis aux contacts.
// `messages` est la liste complète du compte ; le tri BR-B-03/05/09 est délégué
// à pourExecution().
export function demarrerExecution(compte, messages, { at }) {
  if (compte.etat !== ETATS.EN_EXECUTION) {
    throw new Error("l'exécution ne démarre qu'à l'expiration de la période de grâce (BR-D-01)");
  }
  if (compte.execution) throw new Error('exécution déjà démarrée');

  const tri = pourExecution(messages, at);
  const notificationsAt = ajouterJours(at, PREAVIS_CONTACTS_JOURS); // A-7
  const plis = [];

  // Une vague immédiate, étalée sur 72 h (BR-D-02), et un pli par destinataire
  // regroupant tous ses messages (BR-D-03).
  const immediats = tri.executables.filter(({ version }) => version.delivrance.mode === 'IMMEDIATE');
  const groupes = new Map();
  for (const { message, version } of immediats) {
    for (const dest of version.destinataires) {
      if (!groupes.has(dest.email)) groupes.set(dest.email, { destinataire: dest, entrees: [] });
      groupes.get(dest.email).entrees.push({ message, version });
    }
  }
  const total = groupes.size;
  let rang = 0;
  for (const { destinataire, entrees } of groupes.values()) {
    const decalage = total > 1 ? Math.round((ETALEMENT_VAGUE_H * HEURE * rang) / total) : 0;
    plis.push(creerPli({
      id: `pli-${plis.length + 1}`, destinataire, entrees,
      type: 'IMMEDIAT', prevuLe: notificationsAt + decalage,
    }));
    rang += 1;
  }

  // Messages à date fixe : un pli par destinataire et par date (BR-D-04).
  const differes = tri.executables.filter(({ version }) => version.delivrance.mode === 'DATE_FIXE');
  const groupesDiffere = new Map();
  for (const { message, version } of differes) {
    for (const dest of version.destinataires) {
      const cle = `${dest.email}@${version.delivrance.dateFixe}`;
      if (!groupesDiffere.has(cle)) {
        groupesDiffere.set(cle, { destinataire: dest, entrees: [], date: version.delivrance.dateFixe });
      }
      groupesDiffere.get(cle).entrees.push({ message, version });
    }
  }
  for (const { destinataire, entrees, date } of groupesDiffere.values()) {
    plis.push(creerPli({
      id: `pli-${plis.length + 1}`, destinataire, entrees,
      type: 'DIFFERE', prevuLe: Math.max(date, notificationsAt),
    }));
  }

  compte.execution = { demarreeLe: at, notificationsAt, plis };
  noterExecution(compte, at, 'EXECUTION_PLANIFIEE', {
    plisImmediats: total,
    plisDifferes: plis.length - total,
    messagesEnAttente: tri.enAttente.length, // BR-B-09
    messagesExclus: tri.exclus.length,       // BR-B-03 : brouillons
  });
  // A-7 : un humain doit pouvoir prévenir avant l'automate (R-D-1).
  noterExecution(compte, at, 'PREAVIS_CONTACTS', { notificationsDestinatairesLe: notificationsAt });
  return compte.execution;
}

function notifier(compte, pli, at, motif) {
  pli.etat = ETATS_PLI.NOTIFIE;
  pli.notifieLe = at;
  pli.lienExpireLe = ajouterMois(at, LIEN_VALIDITE_MOIS); // BR-D-09
  pli.rappelLe = null;
  noterExecution(compte, at, 'NOTIFICATION_ENVOYEE', {
    pli: pli.id,
    canal: pli.canal,
    motif,
    messages: pli.messages.length,
    contenuInclus: false, // BR-D-08 : l'email ne contient qu'un lien
    langue: pli.destinataire.langue,
  });
}

// Contenu réellement transmis dans la notification : aucune donnée de message
// (BR-D-08). Cette fonction existe pour que la règle soit testable.
export function contenuNotification(pli) {
  return {
    canal: pli.canal,
    langue: pli.destinataire.langue,
    prenomNom: pli.destinataire.prenomNom,
    lien: `/pli/${pli.id}`,
    nombreMessages: pli.messages.length,
  };
}

// Signalé par l'infrastructure d'envoi : adresse définitivement injoignable.
export function signalerRebond(compte, { pliId, at }) {
  const pli = trouverPli(compte, pliId);
  if (![ETATS_PLI.NOTIFIE, ETATS_PLI.SAS_OUVERT].includes(pli.etat)) {
    throw new Error('rebond possible sur un pli notifié');
  }
  pli.rebond = true;
  pli.tentatives = 0;
  pli.prochaineTentative = ajouterJours(at, TENTATIVE_PAS_JOURS);
  noterExecution(compte, at, 'REBOND_PERMANENT', { pli: pli.id, canal: pli.canal });
}

// Une étape due pour un pli ; retourne true si quelque chose a changé.
function etapePli(compte, pli, at) {
  if (pli.etat === ETATS_PLI.PLANIFIE && at >= pli.prevuLe) {
    notifier(compte, pli, at, pli.type === 'DIFFERE' ? 'DATE_PROGRAMMEE' : 'VAGUE_IMMEDIATE');
    return true;
  }

  // Rappel demandé par le destinataire lui-même depuis le sas (« Plus tard »).
  if (pli.rappelLe != null && at >= pli.rappelLe
      && [ETATS_PLI.NOTIFIE, ETATS_PLI.SAS_OUVERT].includes(pli.etat)) {
    pli.rappelLe = null;
    noterExecution(compte, at, 'RAPPEL_DEMANDE_ENVOYE', { pli: pli.id, canal: pli.canal });
    return true;
  }

  // BR-D-07 : rebond permanent → 3 tentatives sur 30 jours, puis secours,
  // puis signalement à l'exécuteur, puis statut « non délivré ».
  if (pli.rebond && pli.prochaineTentative != null && at >= pli.prochaineTentative) {
    if (pli.tentatives < TENTATIVES_MAX) {
      pli.tentatives += 1;
      pli.prochaineTentative = ajouterJours(pli.prochaineTentative, TENTATIVE_PAS_JOURS);
      noterExecution(compte, at, 'NOUVELLE_TENTATIVE', { pli: pli.id, numero: pli.tentatives, canal: pli.canal });
      return true;
    }
    const avecSecours = pli.messages.find((m) => m.secours);
    if (avecSecours && !pli.secoursUtilise) {
      pli.secoursUtilise = true;
      pli.rebond = false;
      pli.tentatives = 0;
      pli.prochaineTentative = null;
      pli.destinataire = { ...avecSecours.secours };
      pli.canal = avecSecours.secours.email;
      noterExecution(compte, at, 'BASCULE_SECOURS', { pli: pli.id, canal: pli.canal }); // BR-B-13
      notifier(compte, pli, at, 'DESTINATAIRE_SECOURS');
      return true;
    }
    pli.etat = ETATS_PLI.NON_DELIVRE;
    pli.rebond = false;
    pli.prochaineTentative = null;
    pli.conservationFinAt = ajouterMois(at, CONSERVATION_MOIS);
    noterExecution(compte, at, 'NON_DELIVRE', {
      pli: pli.id,
      signaleExecuteur: true, // BR-D-07 / BR-A-19 (c)
      conservationFinAt: pli.conservationFinAt,
    });
    return true;
  }

  // BR-D-09 : lien de 12 mois échu sans que le pli ait été ouvert.
  if ([ETATS_PLI.NOTIFIE, ETATS_PLI.SAS_OUVERT].includes(pli.etat)
      && pli.lienExpireLe != null && at >= pli.lienExpireLe) {
    pli.etat = ETATS_PLI.EXPIRE;
    // Un pli jamais ouvert est en substance non délivré (R-B-4 : l'email a pu
    // finir en spam). On ne détruit donc pas dans la foulée : conservation de
    // 12 mois et signalement, comme BR-D-07.
    pli.conservationFinAt = ajouterMois(at, CONSERVATION_MOIS);
    noterExecution(compte, at, 'LIEN_EXPIRE', {
      pli: pli.id,
      signaleExecuteur: true,
      conservationFinAt: pli.conservationFinAt,
    });
    return true;
  }

  // Fin de conservation : refus (BR-D-11), non délivré (BR-D-07), accès en
  // ligne après lecture (§5.2 point 4), lien expiré.
  if (pli.conservationFinAt != null && at >= pli.conservationFinAt
      && [ETATS_PLI.LU, ETATS_PLI.REFUSE, ETATS_PLI.NON_DELIVRE, ETATS_PLI.EXPIRE].includes(pli.etat)) {
    const precedent = pli.etat;
    pli.etat = ETATS_PLI.EFFACE;
    pli.conservationFinAt = null;
    for (const m of pli.messages) { m.texte = null; m.images = []; }
    noterExecution(compte, at, 'PLI_EFFACE', { pli: pli.id, precedent });
  }
  return false;
}

// Moteur d'échéances de l'exécution. Ne relance JAMAIS un destinataire qui
// n'ouvre pas (§7.3) : seules les tentatives techniques sur rebond existent.
// Cascade toutes les étapes dues, comme tick() côté compte.
export function tickExecution(compte, at) {
  if (!compte.execution) return [];
  const avant = compte.journal.length;
  for (const pli of compte.execution.plis) {
    let garde = 0;
    while (etapePli(compte, pli, at) && garde++ < 500) { /* cascade */ }
  }
  return compte.journal.slice(avant);
}

// ————————————————————————————————— parcours du destinataire (§5.2)

// Étape 2, le sas : décrit sans jamais dévoiler.
export function ouvrirSas(compte, { pliId, at }) {
  const pli = trouverPli(compte, pliId);
  if (pli.etat === ETATS_PLI.EXPIRE || pli.etat === ETATS_PLI.EFFACE) {
    throw new Error('ce lien a expiré (BR-D-09)');
  }
  if (![ETATS_PLI.NOTIFIE, ETATS_PLI.SAS_OUVERT, ETATS_PLI.LU].includes(pli.etat)) {
    throw new Error('pli non accessible');
  }
  if (pli.etat === ETATS_PLI.NOTIFIE) {
    pli.etat = ETATS_PLI.SAS_OUVERT;
    pli.sasOuvertLe = at;
    const fortImpact = pli.messages.some((m) => m.nature.fortImpact);
    // BR-D-13 : sas renforcé, délai de réflexion de 24 h avant ouverture possible.
    pli.reflexionFinAt = fortImpact ? at + REFLEXION_FORT_IMPACT_H * HEURE : at;
    noterExecution(compte, at, 'SAS_OUVERT', { pli: pli.id, fortImpact });
  }
  return {
    testateur: compte.id,
    messages: pli.messages.map((m) => ({
      dateMessage: m.dateMessage,
      derniereModif: m.derniereModif,
      note: m.note,        // BR-B-07 : le seul texte affiché avant ouverture
      nature: m.nature,
    })),
    fortImpact: pli.messages.some((m) => m.nature.fortImpact),
    reflexionFinAt: pli.reflexionFinAt,
    choix: ['OUVRIR', 'PLUS_TARD', 'REFUSER'], // §5.2 : trois choix de même poids
    ressourcesDeuil: pli.destinataire.langue,  // BR-L-06 : propres au pays
  };
}

// Étape 3, la vérification : code à usage unique, pas de création de compte
// (BR-D-10). Le code vient de l'infrastructure — le noyau reste déterministe.
export function envoyerCode(compte, { pliId, code, at }) {
  const pli = trouverPli(compte, pliId);
  if (pli.etat !== ETATS_PLI.SAS_OUVERT) throw new Error('ouvrir le sas avant de demander un code');
  pli.code = { valeur: code, expireLe: at + CODE_VALIDITE_MIN * 60_000, utilise: false };
  noterExecution(compte, at, 'CODE_ENVOYE', { pli: pli.id, canal: pli.canal });
}

export function verifierCode(compte, { pliId, code, at }) {
  const pli = trouverPli(compte, pliId);
  if (!pli.code || pli.code.utilise) throw new Error('aucun code en attente');
  if (at > pli.code.expireLe) throw new Error('code expiré');
  if (pli.code.valeur !== code) throw new Error('code incorrect');
  pli.code.utilise = true;
  pli.codeVerifieLe = at;
  noterExecution(compte, at, 'CODE_VERIFIE', { pli: pli.id });
}

// Ouverture effective. La lecture est enregistrée (BR-D-06) mais communiquée à
// personne (BR-D-12).
export function lire(compte, { pliId, at }) {
  const pli = trouverPli(compte, pliId);
  if (pli.etat === ETATS_PLI.EFFACE || pli.etat === ETATS_PLI.EXPIRE) throw new Error('ce lien a expiré (BR-D-09)');
  if (pli.etat === ETATS_PLI.REFUSE) throw new Error('pli refusé par le destinataire (BR-D-11)');
  if (!pli.codeVerifieLe) throw new Error('vérification par code à usage unique requise (BR-D-10)');
  if (at < pli.reflexionFinAt) {
    throw new Error('message à fort impact : délai de réflexion de 24 h (BR-D-13)');
  }
  if (pli.etat !== ETATS_PLI.LU) {
    pli.etat = ETATS_PLI.LU;
    pli.luLe = at;
    pli.conservationFinAt = ajouterMois(at, CONSERVATION_MOIS); // §5.2 point 4
    noterExecution(compte, at, 'LECTURE_ENREGISTREE', {
      pli: pli.id,
      diffusion: 'AUCUNE', // BR-D-12 : n'est communiquée à personne
      accesJusquau: pli.conservationFinAt,
    });
  }
  return pli.messages.map((m) => ({ texte: m.texte, images: m.images, note: m.note }));
}

// §5.2 point 4 : le téléchargement est mis en avant — le service n'est pas
// un conservatoire éternel.
export function telecharger(compte, { pliId, at }) {
  const pli = trouverPli(compte, pliId);
  if (pli.etat !== ETATS_PLI.LU) throw new Error('ouvrir le message avant de le télécharger');
  pli.telechargeLe = at;
  noterExecution(compte, at, 'TELECHARGEMENT', { pli: pli.id, format: 'ARCHIVE_AUTONOME' });
  return { messages: pli.messages.map((m) => ({ texte: m.texte, images: m.images })) };
}

// « Plus tard » : rappel à 1, 3 ou 6 mois, choisi par le destinataire.
export function differer(compte, { pliId, mois, at }) {
  const pli = trouverPli(compte, pliId);
  if (!RAPPELS_AUTORISES_MOIS.includes(mois)) throw new Error('rappel à 1, 3 ou 6 mois (§5.2)');
  if (![ETATS_PLI.NOTIFIE, ETATS_PLI.SAS_OUVERT].includes(pli.etat)) throw new Error('pli non différable');
  pli.rappelLe = ajouterMois(at, mois);
  noterExecution(compte, at, 'RAPPEL_DEMANDE', { pli: pli.id, rappelLe: pli.rappelLe });
}

// BR-D-11 : refus définitif ; le contenu est conservé 12 mois au cas où le
// destinataire changerait d'avis, puis supprimé.
export function refuser(compte, { pliId, at }) {
  const pli = trouverPli(compte, pliId);
  if (![ETATS_PLI.NOTIFIE, ETATS_PLI.SAS_OUVERT].includes(pli.etat)) throw new Error('pli non refusable');
  pli.etat = ETATS_PLI.REFUSE;
  pli.refuseLe = at;
  pli.conservationFinAt = ajouterMois(at, CONSERVATION_MOIS);
  noterExecution(compte, at, 'REFUS_DESTINATAIRE', {
    pli: pli.id,
    signaleExecuteur: true, // BR-D-11
    conservationFinAt: pli.conservationFinAt,
  });
}

// Le destinataire peut revenir sur son refus tant que la conservation court.
export function revenirSurRefus(compte, { pliId, at }) {
  const pli = trouverPli(compte, pliId);
  if (pli.etat !== ETATS_PLI.REFUSE) throw new Error('aucun refus à annuler');
  pli.etat = ETATS_PLI.SAS_OUVERT;
  pli.refuseLe = null;
  pli.conservationFinAt = null;
  noterExecution(compte, at, 'REFUS_ANNULE', { pli: pli.id });
}

// BR-D-14 : droit d'opposition et d'effacement du destinataire sur SES données.
export function oppositionDestinataire(compte, { pliId, at }) {
  const pli = trouverPli(compte, pliId);
  pli.destinataire = { prenomNom: null, email: null, tel: null, langue: pli.destinataire.langue };
  pli.canal = null;
  pli.etat = ETATS_PLI.EFFACE;
  pli.conservationFinAt = null;
  for (const m of pli.messages) { m.texte = null; m.images = []; }
  noterExecution(compte, at, 'OPPOSITION_DESTINATAIRE', { pli: pli.id, donneesEffacees: true });
}

// Vue d'ensemble, notamment pour le journal remis à l'exécuteur (BR-A-19 d).
export function etatExecution(compte) {
  if (!compte.execution) return null;
  const parEtat = {};
  for (const pli of compte.execution.plis) parEtat[pli.etat] = (parEtat[pli.etat] || 0) + 1;
  return {
    demarreeLe: compte.execution.demarreeLe,
    notificationsAt: compte.execution.notificationsAt,
    plis: compte.execution.plis.length,
    parEtat,
    vagueImmediateTerminee: compte.execution.plis
      .filter((p) => p.type === 'IMMEDIAT')
      .every((p) => p.etat !== ETATS_PLI.PLANIFIE),
  };
}
