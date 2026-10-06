// Machine à états du compte — implémente le protocole de preuve de vie de la
// spécification v0.1 (docs/specifications-v0.1.md), sections 4.2 à 4.4.
// Les codes BR-* cités renvoient aux règles métier du document de référence.
// Tout le temps est injecté (paramètre `at`) ; toute transition est journalisée.

import { ajouterJours, ajouterMois } from './horloge.js';
import { consigner } from './journal.js';
import { contactsAcceptants } from './contacts.js';

export const ETATS = Object.freeze({
  NOUVEAU: 'NOUVEAU',
  ARME: 'ARME',
  EN_PAUSE: 'EN_PAUSE',
  SOLLICITATION: 'SOLLICITATION',
  ENQUETE: 'ENQUETE',
  VEILLE_LONGUE: 'VEILLE_LONGUE',
  PRESUME_DECEDE: 'PRESUME_DECEDE',
  EN_EXECUTION: 'EN_EXECUTION',
  EXECUTE: 'EXECUTE',
  EN_LIQUIDATION: 'EN_LIQUIDATION',
  DESARME: 'DESARME',
  SUPPRIME: 'SUPPRIME',
});

export const CADENCES_MOIS = [1, 3, 6, 12];          // 4.2 — cadence de check-in
const OFFSETS_SOLLICITATIONS = [0, 14, 28, 42, 56];  // Phase 1 : J+0 … J+56
const ENQUETE_JOUR = 56;                             // Phase 2
const DECISION_JOUR = 86;                            // Phase 3
const S2_DECALAGE_JOURS = 30;                        // BR-C-04
const VIVANT_SUSPENSION_JOURS = 60;                  // Phase 2, réponse « il va bien »
const GRACE_JOURS = 90;                              // BR-C-06 — non réductible
const PLANCHER_INACTIVITE_MOIS = 18;                 // BR-C-05
const VEILLE_REENQUETE_MOIS = 6;                     // Phase 3, retour en veille
const VEILLE_ENQUETE_JOURS = 30;
const VERIF_RENFORCEE_JOURS = 30;                    // chemin accéléré
const VERIF_RENFORCEE_PAS_JOURS = 5;
const LIQUIDATION_JOURS = 90;                        // BR-E-01
const PAUSE_MAX_MOIS = 12;                           // BR-C-07
const PAUSE_RENOUVELLEMENTS_MAX = 1;
const ATTESTATION_INTERVALLE_MOIS = 12;              // BR-C-14
const INDISPONIBILITE_SEUIL_JOURS = 7;               // BR-C-13 : au-delà, les compteurs sont décalés
const CANAUX = ['email', 'email2', 'push', 'sms'];

// Les délais que le sas re-vérifie par un autre chemin (AD-12). Les chiffres
// n'existent qu'ici (AP-7) ; le code qui les applique, lui, est distinct.
export const DELAIS = Object.freeze({ GRACE_JOURS, PLANCHER_INACTIVITE_MOIS });

const SIGNAUX_S1 = new Set(['CONNEXION', 'LIEN_SIGNE', 'ACTION_APP']); // S1 — preuve forte
const ETATS_IRREVERSIBLES = [ETATS.EN_EXECUTION, ETATS.EXECUTE, ETATS.EN_LIQUIDATION, ETATS.SUPPRIME];
const ETATS_PROTOCOLE = [ETATS.ARME, ETATS.SOLLICITATION, ETATS.ENQUETE, ETATS.VEILLE_LONGUE, ETATS.PRESUME_DECEDE];
// Comptes dont le protocole court : chacun doit avoir une échéance future (AD-8).
export const ETATS_SOUS_PROTOCOLE = Object.freeze([...ETATS_PROTOCOLE, ETATS.EN_PAUSE]);

// Les garde-fous du socle serveur sont portés par le compte lui-même (§11) :
// - preuveDeRemise (AD-13) : pas d'enquête ni de présomption accélérée sans
//   sollicitations effectivement remises sur deux canaux distincts ;
// - sasExecution (AD-12) : la fin de la grâce DEMANDE l'exécution, seule une
//   confirmation passée par le sas la fait démarrer.
// Désactivés pour le prototype local, qui n'a pas de fournisseur d'envoi.
export function creerCompte({ id, at, cadenceMois = 6, hachage, preuveDeRemise = false, sasExecution = false } = {}) {
  if (!CADENCES_MOIS.includes(cadenceMois)) {
    throw new Error(`cadence de check-in parmi ${CADENCES_MOIS.join('/')} mois (4.2)`);
  }
  const compte = {
    id,
    creeLe: at,
    etat: ETATS.NOUVEAU,
    regles: { cadenceMois, preuveDeRemise: preuveDeRemise === true, sasExecution: sasExecution === true },
    armement: null,        // { at, canauxVerifies, messagesScelles }
    derniereS1: null,
    decalageS1: 0,         // jours neutralisés par incident depuis la dernière S1 (BR-C-13)
    indisponibilites: [],  // identifiants des incidents déjà pris en compte
    vivantSuccessifs: 0,   // réponses « il va bien » sans S1 entre elles
    cycle: null,           // { debut, decalage, s2Utilise, relances, enqueteOuverte }
    veille: null,          // { ouverteLe, prochaineEnquete, enquete: {decisionAt}|null }
    verifRenforcee: null,  // { debut, fin, relancesEmises, signal }
    presomption: null,     // { at, voie, graceFinAt, notifsEmises }
    pause: null,           // { jusquau, renouvellements }
    liquidation: null,     // { finAt }
    attestations: [],      // { contactId, piece, at, invalideeAt }
    contacts: [],
    journal: [],
    _hachage: hachage,
  };
  noterCompte(compte, at, 'COMPTE_CREE', { id, cadenceMois, preuveDeRemise: compte.regles.preuveDeRemise, sasExecution: compte.regles.sasExecution });
  return compte;
}

function noterCompte(compte, at, type, donnees = {}) {
  consigner(compte.journal, { at, type, donnees }, compte._hachage);
}

// Échéance comptée depuis le dernier signe de vie : `mois` calendaires, plus
// les jours neutralisés par un incident. La date de la S1 elle-même n'est
// jamais réécrite : c'est un fait, le décalage est un calcul (AD-9).
function depuisS1(compte, mois) {
  return ajouterJours(ajouterMois(compte.derniereS1, mois), compte.decalageS1 ?? 0);
}

// ————————————————————————————————————————————————— armement (BR-C-01/02)

export function armer(compte, { at, auth = {}, canauxVerifies = 0, messagesScelles = 0, accuseLecture = false }) {
  if (compte.etat !== ETATS.NOUVEAU && compte.etat !== ETATS.DESARME) {
    throw new Error('armement possible depuis un compte nouveau ou désarmé');
  }
  if (auth.deuxFacteurs !== true) throw new Error('armement : 2FA active requise (BR-C-01, BR-A-02)');
  if (canauxVerifies < 2) throw new Error('armement : deux canaux vérifiés distincts requis (BR-A-03)');
  if (messagesScelles < 1) throw new Error('armement : au moins un message scellé requis (BR-C-01)');
  if (accuseLecture !== true) throw new Error('armement : accusé de lecture du protocole requis (BR-C-02)');
  compte.etat = ETATS.ARME;
  compte.armement = { at, canauxVerifies, messagesScelles };
  compte.derniereS1 = at;
  compte.decalageS1 = 0;
  noterCompte(compte, at, 'COMPTE_ARME', { cadenceMois: compte.regles.cadenceMois, canauxVerifies, messagesScelles, accuseLectureAt: at });
}

export function desarmer(compte, { at, auth = {} }) {
  if (compte.etat !== ETATS.ARME) throw new Error('désarmement possible depuis un compte armé serein');
  if (auth.deuxFacteurs !== true) throw new Error('désarmement : 2FA requise (BR-A-06)');
  compte.etat = ETATS.DESARME;
  noterCompte(compte, at, 'COMPTE_DESARME', {});
}

// Raccourcir la cadence est immédiat ; l'allonger exige une 2FA (4.2).
export function changerCadence(compte, { cadenceMois, at, auth = {} }) {
  if (!CADENCES_MOIS.includes(cadenceMois)) {
    throw new Error(`cadence de check-in parmi ${CADENCES_MOIS.join('/')} mois (4.2)`);
  }
  if (cadenceMois > compte.regles.cadenceMois && auth.deuxFacteurs !== true) {
    throw new Error('allonger la cadence exige une confirmation 2FA (4.2)');
  }
  const avant = compte.regles.cadenceMois;
  compte.regles.cadenceMois = cadenceMois;
  noterCompte(compte, at, 'CADENCE_MODIFIEE', { avant, apres: cadenceMois });
}

// ————————————————————————————————————————————————— signaux (4.2, BR-C-03/04)

// S1 — preuve de vie forte : réinitialise tout, sans exception (PD-3, BR-C-03).
export function signalS1(compte, { type = 'CONNEXION', at }) {
  if (!SIGNAUX_S1.has(type)) throw new Error(`signal S1 parmi : ${[...SIGNAUX_S1].join(', ')}`);
  if (ETATS_IRREVERSIBLES.includes(compte.etat)) {
    throw new Error("l'exécution est irréversible : aucun signal ne l'arrête (BR-D-01)");
  }
  const annulePresomption = compte.etat === ETATS.PRESUME_DECEDE;
  if (compte.pause) {
    compte.pause = null;
    noterCompte(compte, at, 'PAUSE_INTERROMPUE', {});
  }
  if (annulePresomption) {
    noterCompte(compte, at, 'PRESOMPTION_ANNULEE', { par: 'S1' });
    communiquerAttestants(compte, at); // BR-A-17
  }
  invaliderAttestations(compte, at);
  compte.vivantSuccessifs = 0;
  compte.cycle = null;
  compte.veille = null;
  compte.verifRenforcee = null;
  compte.presomption = null;
  if (ETATS_PROTOCOLE.includes(compte.etat) || compte.etat === ETATS.EN_PAUSE) {
    compte.etat = ETATS.ARME;
  }
  compte.derniereS1 = at;
  compte.decalageS1 = 0;
  noterCompte(compte, at, 'SIGNE_DE_VIE_S1', { type });
  return { compteurReinitialise: true, presomptionAnnulee: annulePresomption };
}

// S2 — signal faible : ne réinitialise jamais le compteur (BR-C-04).
export function signalS2(compte, { type = 'OUVERTURE_EMAIL', at, explicite = false }) {
  if (ETATS_IRREVERSIBLES.includes(compte.etat)) {
    throw new Error("l'exécution est irréversible : aucun signal ne l'arrête (BR-D-01)");
  }
  if (compte.etat === ETATS.PRESUME_DECEDE) {
    if (!explicite) {
      noterCompte(compte, at, 'S2_RECU', { type, effet: 'AUCUN' });
      return { effet: 'AUCUN' };
    }
    // Phase 4 : un S2 explicite (« je suis vivant ») annule la présomption,
    // mais ne réinitialise pas le compteur : un check-in S1 est redemandé.
    noterCompte(compte, at, 'PRESOMPTION_ANNULEE', { par: 'S2_EXPLICITE' });
    communiquerAttestants(compte, at); // BR-A-17
    invaliderAttestations(compte, at);
    compte.presomption = null;
    ouvrirSollicitation(compte, at, at, 'APRES_ANNULATION_S2');
    return { effet: 'PRESOMPTION_ANNULEE' };
  }
  if (compte.verifRenforcee) {
    compte.verifRenforcee.signal = true; // brise le « silence total » du chemin accéléré
    noterCompte(compte, at, 'S2_RECU', { type, effet: 'VERIFICATION_INTERROMPUE' });
    return { effet: 'VERIFICATION_INTERROMPUE' };
  }
  if (compte.cycle && !compte.cycle.s2Utilise) {
    compte.cycle.s2Utilise = true;
    compte.cycle.decalage += S2_DECALAGE_JOURS;
    noterCompte(compte, at, 'S2_DECALAGE', { type, jours: S2_DECALAGE_JOURS });
    return { effet: 'DECALAGE_30_JOURS' };
  }
  noterCompte(compte, at, 'S2_RECU', { type, effet: 'AUCUN' });
  return { effet: 'AUCUN' };
}

function invaliderAttestations(compte, at) {
  for (const a of compte.attestations) {
    if (!a.invalideeAt) a.invalideeAt = at;
  }
}

// BR-A-17 : en cas de réactivation, les attestants sont nommés au testateur.
function communiquerAttestants(compte, at) {
  const attestants = compte.attestations.filter((a) => !a.invalideeAt).map((a) => a.contactId);
  if (attestants.length) noterCompte(compte, at, 'ATTESTANTS_COMMUNIQUES', { contacts: attestants });
}

// ————————————————————————————————————————————————— S3 : attestations (BR-C-08/09/14)

export function attesterDeces(compte, { contactId, piece = null, at }) {
  const contact = contactsAcceptants(compte).find((c) => c.id === contactId);
  if (!contact) throw new Error('seul un contact de confiance acceptant peut attester (BR-A-11)');
  if (ETATS_IRREVERSIBLES.includes(compte.etat)) throw new Error('compte déjà en exécution');
  if (compte.etat === ETATS.NOUVEAU || compte.etat === ETATS.DESARME) {
    throw new Error('compte non armé : le protocole ne court pas (BR-C-01)');
  }
  const derniere = compte.attestations.filter((a) => a.contactId === contactId).at(-1);
  if (derniere && at < ajouterMois(derniere.at, ATTESTATION_INTERVALLE_MOIS)) {
    throw new Error('une attestation par contact et par période de 12 mois (BR-C-14)');
  }
  compte.attestations.push({ contactId, piece, at, invalideeAt: null });
  noterCompte(compte, at, 'ATTESTATION_RECUE', { contactId, piece: Boolean(piece) });

  // Chemin accéléré (4.2) : attestation proactive hors enquête.
  if (compte.etat === ETATS.ARME || compte.etat === ETATS.SOLLICITATION || compte.etat === ETATS.EN_PAUSE) {
    if (quorumAtteint(compte)) {
      compte.pause = null;
      compte.cycle = null;
      compte.verifRenforcee = { debut: at, fin: ajouterJours(at, VERIF_RENFORCEE_JOURS), relancesEmises: 0, signal: false, remises: [], bloque: false };
      compte.etat = ETATS.ENQUETE;
      noterCompte(compte, at, 'VERIFICATION_RENFORCEE_OUVERTE', { fin: compte.verifRenforcee.fin });
    } else if (compte.etat === ETATS.ARME) {
      // BR-C-09 : sans quorum possible, l'attestation ne fait qu'accélérer la Phase 1.
      ouvrirSollicitation(compte, at, at, 'ATTESTATION_SANS_QUORUM');
    }
  }
  // En enquête ou en veille : comptée au point de décision. En grâce : sans
  // effet, la grâce est non réductible (BR-C-06).
}

// Réponse d'un contact à l'enquête de Phase 2 (4.2).
export function repondreEnquete(compte, { contactId, reponse, piece = null, at }) {
  const contact = contactsAcceptants(compte).find((c) => c.id === contactId);
  if (!contact) throw new Error('seul un contact de confiance acceptant peut répondre (BR-A-11)');
  if (reponse === 'DECEDE') {
    attesterDeces(compte, { contactId, piece, at });
    return;
  }
  const enqueteOuverte = (compte.cycle && compte.cycle.enqueteOuverte) || (compte.veille && compte.veille.enquete) || compte.verifRenforcee;
  if (!enqueteOuverte) throw new Error('aucune enquête en cours');
  if (reponse === 'NSP') {
    noterCompte(compte, at, 'REPONSE_ENQUETE', { contactId, reponse, effet: 'AUCUN' });
    return;
  }
  if (reponse !== 'VIVANT') throw new Error('réponse parmi : VIVANT, DECEDE, NSP');
  // « Il va bien » : suspension de 60 jours ; deux réponses successives sans
  // aucun signal S1 ne suspendent plus (4.2).
  if (compte.vivantSuccessifs >= 1) {
    compte.vivantSuccessifs += 1;
    noterCompte(compte, at, 'REPONSE_ENQUETE', { contactId, reponse, effet: 'AUCUN_DEUX_SUCCESSIVES' });
    return;
  }
  compte.vivantSuccessifs += 1;
  if (compte.verifRenforcee) {
    compte.verifRenforcee.signal = true;
    noterCompte(compte, at, 'REPONSE_ENQUETE', { contactId, reponse, effet: 'VERIFICATION_INTERROMPUE' });
    return;
  }
  if (compte.cycle) compte.cycle.decalage += VIVANT_SUSPENSION_JOURS;
  if (compte.veille && compte.veille.enquete) {
    compte.veille.enquete.decisionAt = ajouterJours(compte.veille.enquete.decisionAt, VIVANT_SUSPENSION_JOURS);
  }
  noterCompte(compte, at, 'REPONSE_ENQUETE', { contactId, reponse, effet: `SUSPENSION_${VIVANT_SUSPENSION_JOURS}_JOURS` });
}

// Le quorum peut-il encore être atteint ? Deux acceptants, ou un seul qui
// joindra une pièce justificative (BR-A-14, BR-C-08).
export function quorumPossible(compte) {
  return contactsAcceptants(compte).length >= 1;
}

// Quorum (BR-A-14, BR-C-08) : 2 attestations d'acceptants distincts, ou une
// seule avec pièce lorsqu'un seul contact est acceptant.
export function quorumAtteint(compte) {
  const acceptants = contactsAcceptants(compte);
  const valides = compte.attestations.filter(
    (a) => !a.invalideeAt && acceptants.some((c) => c.id === a.contactId),
  );
  const distincts = new Set(valides.map((a) => a.contactId));
  if (distincts.size >= 2) return true;
  if (acceptants.length === 1 && valides.some((a) => a.piece)) return true;
  return false;
}

// ————————————————————————————————————————————————— pause (BR-C-07)

export function demarrerPause(compte, { jusquau, at, auth = {} }) {
  if (compte.etat !== ETATS.ARME) throw new Error('absence programmée possible depuis un compte armé serein (BR-C-07)');
  if (auth.deuxFacteurs !== true) throw new Error('absence programmée : 2FA requise (BR-C-07)');
  if (jusquau <= at) throw new Error('échéance de pause dans le passé');
  if (jusquau > ajouterMois(at, PAUSE_MAX_MOIS)) throw new Error('absence programmée de 1 à 12 mois (BR-C-07)');
  compte.etat = ETATS.EN_PAUSE;
  compte.pause = { jusquau, renouvellements: 0 };
  noterCompte(compte, at, 'PAUSE_DEMARREE', { jusquau });
}

export function renouvelerPause(compte, { jusquau, at, auth = {} }) {
  if (compte.etat !== ETATS.EN_PAUSE) throw new Error('aucune pause en cours');
  if (auth.deuxFacteurs !== true) throw new Error('absence programmée : 2FA requise (BR-C-07)');
  if (compte.pause.renouvellements >= PAUSE_RENOUVELLEMENTS_MAX) {
    throw new Error('absence programmée renouvelable une seule fois (BR-C-07)');
  }
  if (jusquau <= compte.pause.jusquau) throw new Error('le renouvellement doit prolonger la pause');
  if (jusquau > ajouterMois(at, PAUSE_MAX_MOIS)) throw new Error('absence programmée de 1 à 12 mois (BR-C-07)');
  compte.pause = { jusquau, renouvellements: compte.pause.renouvellements + 1 };
  noterCompte(compte, at, 'PAUSE_RENOUVELEE', { jusquau });
}

// ————————————————————————————————————————————————— incident (BR-C-13)

export function decalerCompteurs(compte, { jours, at, motif = 'INCIDENT_SERVICE' }) {
  if (jours <= 0) throw new Error('décalage strictement positif');
  if (compte.derniereS1 != null) compte.decalageS1 = (compte.decalageS1 ?? 0) + jours;
  if (compte.cycle) compte.cycle.debut = ajouterJours(compte.cycle.debut, jours);
  if (compte.veille) {
    compte.veille.ouverteLe = ajouterJours(compte.veille.ouverteLe, jours);
    compte.veille.prochaineEnquete = ajouterJours(compte.veille.prochaineEnquete, jours);
    if (compte.veille.enquete) compte.veille.enquete.decisionAt = ajouterJours(compte.veille.enquete.decisionAt, jours);
  }
  if (compte.verifRenforcee) compte.verifRenforcee.fin = ajouterJours(compte.verifRenforcee.fin, jours);
  if (compte.presomption) compte.presomption.graceFinAt = ajouterJours(compte.presomption.graceFinAt, jours);
  noterCompte(compte, at, 'COMPTEURS_DECALES', { jours, motif });
}

// Incident de service déclaré par l'exploitation (AD-9, BR-C-13). Au-delà de
// sept jours, sa durée est neutralisée : toutes les échéances reculent
// d'autant. En deçà, il est seulement constaté. Un même incident n'est
// jamais compté deux fois.
export function constaterIndisponibilite(compte, { id, debut, fin, cause = 'INCIDENT_SERVICE', at }) {
  if (typeof id !== 'string' || !id) throw new Error('indisponibilité : identifiant requis');
  if (!(Number.isFinite(debut) && Number.isFinite(fin) && fin > debut)) throw new Error('indisponibilité : période invalide');
  compte.indisponibilites ??= [];
  if (compte.indisponibilites.includes(id)) return { dejaPrise: true };
  compte.indisponibilites.push(id);
  const jours = (fin - debut) / 86_400_000;
  const aDecaler = jours > INDISPONIBILITE_SEUIL_JOURS
    && (ETATS_PROTOCOLE.includes(compte.etat) || compte.etat === ETATS.EN_PAUSE);
  noterCompte(compte, at, 'INDISPONIBILITE_CONSTATEE', { id, debut, fin, cause, jours, compteursDecales: aDecaler });
  if (aDecaler) decalerCompteurs(compte, { jours, at, motif: `INDISPONIBILITE ${id}` });
  return { dejaPrise: false, compteursDecales: aDecaler };
}

// ————————————————————————————————————————————————— remises et sas (AD-12, AD-13)

const RESULTATS_REMISE = ['REMIS', 'OUVERT', 'REBOND'];

// Accusé du fournisseur d'envoi. Seule une remise (ou une ouverture) compte :
// un envoi accepté ne prouve rien, un rebond encore moins.
export function noterRemise(compte, { effet, resultat, at }) {
  if (!effet || typeof effet.type !== 'string') throw new Error('accusé de remise : effet requis (AD-13)');
  if (!RESULTATS_REMISE.includes(resultat)) throw new Error(`accusé de remise parmi : ${RESULTATS_REMISE.join(', ')}`);
  noterCompte(compte, at, 'REMISE_RECUE', {
    effet: effet.type, canal: effet.canal ?? null, contactId: effet.contactId ?? null, prevueLe: effet.prevueLe ?? null, resultat,
  });
  if (resultat === 'REBOND' || !effet.canal) return;
  // Seules comptent les remises de la phase en cours : un accusé tardif d'un
  // cycle ancien ne débloque rien.
  const ajouter = (phase) => {
    phase.remises ??= [];
    if (!phase.remises.includes(effet.canal)) phase.remises.push(effet.canal);
  };
  if (effet.type === 'SOLLICITATION' && compte.cycle && effet.prevueLe >= compte.cycle.debut) ajouter(compte.cycle);
  if (effet.type === 'RELANCE_RENFORCEE' && compte.verifRenforcee && effet.prevueLe >= compte.verifRenforcee.debut) {
    ajouter(compte.verifRenforcee);
  }
}

// Le sas a vérifié ses cinq verrous (AD-12) et, en période d'amorçage, un
// opérateur a confirmé (AD-15) : seulement alors l'exécution démarre.
export function confirmerExecution(compte, { par, at }) {
  if (!compte.regles.sasExecution) throw new Error("ce compte n'a pas de sas d'exécution");
  if (compte.etat !== ETATS.PRESUME_DECEDE || !compte.presomption?.executionDemandee) {
    throw new Error("aucune demande d'exécution en attente (AD-12)");
  }
  if (typeof par !== 'string' || !par) throw new Error('confirmation nominative requise (AD-15)');
  compte.etat = ETATS.EN_EXECUTION;
  noterCompte(compte, at, 'EXECUTION_DEMARREE', {
    grace: `${GRACE_JOURS} jours révolus`, prevueLe: compte.presomption.executionDemandee, confirmePar: par,
  });
}

// ————————————————————————————————————————————————— moteur d'échéances

function ouvrirSollicitation(compte, debut, at, motif) {
  compte.cycle = { debut, decalage: 0, s2Utilise: false, relances: 0, enqueteOuverte: false, remises: [], bloque: false };
  compte.veille = null;
  compte.etat = ETATS.SOLLICITATION;
  noterCompte(compte, at, 'SOLLICITATION_OUVERTE', { motif, prevueLe: debut });
}

function ouvrirPresomption(compte, quand, at, voie) {
  compte.cycle = null;
  compte.veille = null;
  compte.verifRenforcee = null;
  compte.etat = ETATS.PRESUME_DECEDE;
  compte.presomption = { at: quand, voie, graceFinAt: ajouterJours(quand, GRACE_JOURS), notifsEmises: 0 };
  noterCompte(compte, at, 'PRESOMPTION_DECES', { voie, graceFinAt: compte.presomption.graceFinAt });
}

// Applique AU PLUS UNE transition due ; retourne true si quelque chose a changé.
function etape(compte, at) {
  // Fin de pause → check-in immédiat (BR-C-07, table 4.4)
  if (compte.etat === ETATS.EN_PAUSE && at >= compte.pause.jusquau) {
    const fin = compte.pause.jusquau;
    compte.pause = null;
    noterCompte(compte, at, 'PAUSE_TERMINEE', {});
    ouvrirSollicitation(compte, fin, at, 'FIN_PAUSE');
    return true;
  }

  // Vérification renforcée (chemin accéléré, 4.2)
  if (compte.verifRenforcee) {
    const v = compte.verifRenforcee;
    const prochaine = ajouterJours(v.debut, (v.relancesEmises + 1) * VERIF_RENFORCEE_PAS_JOURS);
    if (v.relancesEmises < 5 && at >= prochaine && prochaine < v.fin) {
      v.relancesEmises += 1;
      noterCompte(compte, at, 'RELANCE_RENFORCEE', { numero: v.relancesEmises, prevueLe: prochaine, canaux: CANAUX });
      return true;
    }
    if (at >= v.fin) {
      const versPresomption = quorumAtteint(compte) && !v.signal;
      // AD-13 : on ne présume pas un décès sur des relances que personne n'a reçues.
      if (versPresomption && compte.regles.preuveDeRemise && (v.remises ?? []).length < 2) {
        if (v.bloque) return false;
        v.bloque = true;
        noterCompte(compte, at, 'REMISE_INSUFFISANTE', { phase: 'VERIFICATION_RENFORCEE', canauxRemis: [...(v.remises ?? [])], prevueLe: v.fin });
        return true;
      }
      const quand = v.bloque ? at : v.fin; // débloqué tard : la suite part d'aujourd'hui
      compte.verifRenforcee = null;
      if (versPresomption) ouvrirPresomption(compte, quand, at, 'ACCELEREE');
      else ouvrirSollicitation(compte, quand, at, 'SORTIE_VERIFICATION_RENFORCEE');
      return true;
    }
    return false;
  }

  // Échéance de cadence → Phase 1
  if (compte.etat === ETATS.ARME && compte.derniereS1 != null) {
    const echeance = depuisS1(compte, compte.regles.cadenceMois);
    if (at >= echeance) {
      ouvrirSollicitation(compte, echeance, at, 'ECHEANCE_CADENCE');
      return true;
    }
  }

  // Phase 1 (sollicitations J+0 … J+56) puis Phase 2 (enquête) puis Phase 3 (décision)
  if (compte.cycle) {
    const c = compte.cycle;
    if (c.relances < OFFSETS_SOLLICITATIONS.length) {
      const prevue = ajouterJours(c.debut, OFFSETS_SOLLICITATIONS[c.relances] + c.decalage);
      if (at >= prevue) {
        c.relances += 1;
        noterCompte(compte, at, 'SOLLICITATION_ENVOYEE', { niveau: c.relances, prevueLe: prevue, canaux: CANAUX });
        return true;
      }
    }
    const quandEnquete = ajouterJours(c.debut, ENQUETE_JOUR + c.decalage);
    if (!c.enqueteOuverte && at >= quandEnquete) {
      // AD-13 : un silence n'en est un que si on a réussi à parler. Sans
      // remise sur deux canaux distincts, le compte n'avance pas et alerte.
      if (compte.regles.preuveDeRemise && (c.remises ?? []).length < 2) {
        if (c.bloque) return false;
        c.bloque = true;
        noterCompte(compte, at, 'REMISE_INSUFFISANTE', { phase: 'SOLLICITATION', canauxRemis: [...(c.remises ?? [])], prevueLe: quandEnquete });
        return true;
      }
      // Débloqué tard : l'enquête s'ouvre maintenant et les contacts gardent
      // leurs trente jours avant la décision.
      if (c.bloque) {
        c.decalage += (at - quandEnquete) / 86_400_000;
        c.bloque = false;
      }
      c.enqueteOuverte = true;
      compte.etat = ETATS.ENQUETE;
      noterCompte(compte, at, 'CONTACTS_SOLLICITES', {
        contacts: contactsAcceptants(compte).map((x) => x.id),
        prevueLe: ajouterJours(c.debut, ENQUETE_JOUR + c.decalage),
      });
      return true;
    }
    const quandDecision = ajouterJours(c.debut, DECISION_JOUR + c.decalage);
    if (c.enqueteOuverte && at >= quandDecision) {
      compte.cycle = null;
      if (quorumAtteint(compte)) {
        ouvrirPresomption(compte, quandDecision, at, 'QUORUM');
      } else {
        compte.etat = ETATS.VEILLE_LONGUE;
        compte.veille = {
          ouverteLe: quandDecision,
          prochaineEnquete: ajouterMois(quandDecision, VEILLE_REENQUETE_MOIS),
          enquete: null,
        };
        noterCompte(compte, at, 'VEILLE_LONGUE_OUVERTE', {
          prochaineEnquete: compte.veille.prochaineEnquete,
          plancherInactivite: depuisS1(compte, PLANCHER_INACTIVITE_MOIS),
        });
      }
      return true;
    }
    return false;
  }

  // Veille longue : ré-enquêtes semestrielles, plancher de 18 mois (BR-C-05)
  if (compte.veille) {
    const v = compte.veille;
    const plancher = depuisS1(compte, PLANCHER_INACTIVITE_MOIS);
    if (at >= plancher) {
      // Jamais avant 18 mois sans S1 ; la grâce court depuis le plus tardif
      // du plancher et de l'ouverture de la veille.
      ouvrirPresomption(compte, Math.max(plancher, v.ouverteLe), at, 'INACTIVITE_18_MOIS');
      return true;
    }
    if (v.enquete && at >= v.enquete.decisionAt) {
      const quand = v.enquete.decisionAt;
      v.enquete = null;
      if (quorumAtteint(compte)) {
        ouvrirPresomption(compte, quand, at, 'QUORUM');
      } else {
        compte.etat = ETATS.VEILLE_LONGUE;
        v.prochaineEnquete = ajouterMois(quand, VEILLE_REENQUETE_MOIS);
        noterCompte(compte, at, 'ENQUETE_SANS_QUORUM', { prochaineEnquete: v.prochaineEnquete });
      }
      return true;
    }
    if (!v.enquete && at >= v.prochaineEnquete) {
      v.enquete = { decisionAt: ajouterJours(v.prochaineEnquete, VEILLE_ENQUETE_JOURS) };
      compte.etat = ETATS.ENQUETE;
      noterCompte(compte, at, 'CONTACTS_SOLLICITES', {
        contacts: contactsAcceptants(compte).map((x) => x.id),
        prevueLe: v.prochaineEnquete,
      });
      return true;
    }
    return false;
  }

  // Période de grâce : notifications hebdomadaires puis exécution (Phase 4/5)
  if (compte.etat === ETATS.PRESUME_DECEDE) {
    const p = compte.presomption;
    const prochaineNotif = ajouterJours(p.at, (p.notifsEmises + 1) * 7);
    if (prochaineNotif < p.graceFinAt && at >= prochaineNotif) {
      p.notifsEmises += 1;
      noterCompte(compte, at, 'RELANCE_GRACE', { numero: p.notifsEmises, prevueLe: prochaineNotif, canaux: CANAUX });
      return true;
    }
    if (at >= p.graceFinAt && !p.executionDemandee) {
      if (compte.regles.sasExecution) {
        // AD-12 : une demande, pas un démarrage. Le compte reste présumé
        // décédé — un signe de vie l'annule encore — jusqu'au sas.
        p.executionDemandee = p.graceFinAt;
        noterCompte(compte, at, 'EXECUTION_DEMANDEE', { grace: `${GRACE_JOURS} jours révolus`, prevueLe: p.graceFinAt });
        return true;
      }
      compte.etat = ETATS.EN_EXECUTION;
      noterCompte(compte, at, 'EXECUTION_DEMARREE', { grace: `${GRACE_JOURS} jours révolus`, prevueLe: p.graceFinAt });
      return true;
    }
    return false;
  }

  // Liquidation → suppression (BR-E-01)
  if (compte.etat === ETATS.EN_LIQUIDATION && at >= compte.liquidation.finAt) {
    compte.etat = ETATS.SUPPRIME;
    noterCompte(compte, at, 'COMPTE_SUPPRIME', { journalMinimalConserve: true });
    return true;
  }

  return false;
}

// Prochain instant où `etape` aura quelque chose à faire (AD-2). Miroir exact
// des conditions de `etape` : chaque branche y teste « at >= X », la prochaine
// échéance est donc le plus petit X actif. Un test vérifie, scénario après
// scénario, qu'aucune transition n'est due une milliseconde plus tôt.
export function prochaineEcheance(compte) {
  if (compte.etat === ETATS.EN_PAUSE && compte.pause) return compte.pause.jusquau;

  if (compte.verifRenforcee) {
    const v = compte.verifRenforcee;
    if (v.bloque) return null; // attend des accusés de remise, pas une date
    const dates = [v.fin];
    const relance = ajouterJours(v.debut, (v.relancesEmises + 1) * VERIF_RENFORCEE_PAS_JOURS);
    if (v.relancesEmises < 5 && relance < v.fin) dates.push(relance);
    return Math.min(...dates);
  }

  if (compte.etat === ETATS.ARME && compte.derniereS1 != null) {
    return depuisS1(compte, compte.regles.cadenceMois);
  }

  if (compte.cycle) {
    const c = compte.cycle;
    const dates = [];
    if (c.relances < OFFSETS_SOLLICITATIONS.length) {
      dates.push(ajouterJours(c.debut, OFFSETS_SOLLICITATIONS[c.relances] + c.decalage));
    }
    if (!(c.bloque && !c.enqueteOuverte)) {
      dates.push(ajouterJours(c.debut, (c.enqueteOuverte ? DECISION_JOUR : ENQUETE_JOUR) + c.decalage));
    }
    return dates.length ? Math.min(...dates) : null;
  }

  if (compte.veille) {
    const v = compte.veille;
    const plancher = depuisS1(compte, PLANCHER_INACTIVITE_MOIS);
    return Math.min(plancher, v.enquete ? v.enquete.decisionAt : v.prochaineEnquete);
  }

  if (compte.etat === ETATS.PRESUME_DECEDE) {
    const p = compte.presomption;
    if (p.executionDemandee) return null; // attend le sas, pas une date
    const notif = ajouterJours(p.at, (p.notifsEmises + 1) * 7);
    return notif < p.graceFinAt ? notif : p.graceFinAt;
  }

  if (compte.etat === ETATS.EN_LIQUIDATION) return compte.liquidation.finAt;
  return null;
}

// Évalue toutes les transitions dues à l'instant `at` (cascade en un appel).
// Rend aussi les changements d'état, chacun avec l'instant où il était dû :
// `evaluer` s'en sert pour refuser un rattrapage qui sauterait des étapes (AD-9).
export function avancerProtocole(compte, at) {
  const avant = compte.journal.length;
  const transitions = [];
  let dernierDu = -Infinity;
  for (let garde = 0; garde < 500; garde++) {
    // Une étape ne peut pas avoir été due avant celle qui l'a rendue possible.
    const du = Math.max(prochaineEcheance(compte) ?? at, dernierDu);
    const de = compte.etat;
    if (!etape(compte, at)) break;
    dernierDu = du;
    if (compte.etat !== de) transitions.push({ de, vers: compte.etat, du });
  }
  return { evenements: compte.journal.slice(avant), transitions };
}

export function tick(compte, at) {
  return avancerProtocole(compte, at).evenements;
}

// Fin de la vague immédiate (module D) → liquidation (module E).
export function terminerExecution(compte, { at }) {
  if (compte.etat !== ETATS.EN_EXECUTION) throw new Error('aucune exécution en cours');
  compte.etat = ETATS.EN_LIQUIDATION;
  compte.liquidation = { finAt: ajouterJours(at, LIQUIDATION_JOURS) };
  noterCompte(compte, at, 'EXECUTION_TERMINEE', {});
  noterCompte(compte, at, 'LIQUIDATION_OUVERTE', { finAt: compte.liquidation.finAt });
}

// Prévision d'exécution (BR-C-11, AD-3). Deux dates, jamais une seule :
// confondre « quorum possible » et « quorum atteint » annonçait une date
// d'exécution que personne n'avait rendue réelle.
// - executionSiRienNeChange : aucun signe de vie, aucune attestation de plus.
// - executionAuPlusTot : les contacts attestent à la prochaine décision ;
//   null si le quorum ne peut plus être atteint.
export function previsionExecution(compte) {
  if (compte.presomption) {
    const g = compte.presomption.graceFinAt; // la grâce est non réductible (BR-C-06)
    return { executionSiRienNeChange: g, executionAuPlusTot: g };
  }
  const rien = { executionSiRienNeChange: null, executionAuPlusTot: null };
  if (compte.derniereS1 == null) return rien;
  if (!ETATS_PROTOCOLE.includes(compte.etat) && compte.etat !== ETATS.EN_PAUSE) return rien;

  const v = compte.verifRenforcee;
  if (v && !v.signal && quorumAtteint(compte)) {
    const x = ajouterJours(v.fin, GRACE_JOURS);
    return { executionSiRienNeChange: x, executionAuPlusTot: x };
  }

  // Prochain point de décision où un quorum ferait basculer le compte, et
  // instant d'ouverture de la veille longue qui suivrait faute de quorum.
  let decision;
  let ouvertureVeille;
  if (compte.veille) {
    const ve = compte.veille;
    decision = ve.enquete ? ve.enquete.decisionAt : ajouterJours(ve.prochaineEnquete, VEILLE_ENQUETE_JOURS);
    ouvertureVeille = ve.ouverteLe;
  } else {
    if (v) decision = ajouterJours(v.fin, DECISION_JOUR); // sortie vers une sollicitation
    else if (compte.cycle) decision = ajouterJours(compte.cycle.debut, DECISION_JOUR + compte.cycle.decalage);
    else if (compte.pause) decision = ajouterJours(compte.pause.jusquau, DECISION_JOUR);
    else decision = ajouterJours(depuisS1(compte, compte.regles.cadenceMois), DECISION_JOUR);
    ouvertureVeille = decision;
  }
  // Sans quorum, présomption au plancher de 18 mois sans S1, jamais avant
  // l'ouverture de la veille (BR-C-05).
  const parPlancher = Math.max(ouvertureVeille, depuisS1(compte, PLANCHER_INACTIVITE_MOIS));
  const presomption = (avecQuorum) => (avecQuorum ? Math.min(decision, parPlancher) : parPlancher);
  return {
    executionSiRienNeChange: ajouterJours(presomption(quorumAtteint(compte)), GRACE_JOURS),
    executionAuPlusTot: quorumPossible(compte) ? ajouterJours(presomption(true), GRACE_JOURS) : null,
  };
}

// Tableau de bord de statut (BR-C-11).
export function prochainesEcheances(compte) {
  const e = {};
  if (compte.derniereS1 != null && ETATS_PROTOCOLE.includes(compte.etat)) {
    e.echeanceCadence = depuisS1(compte, compte.regles.cadenceMois);
    e.plancherInactivite = depuisS1(compte, PLANCHER_INACTIVITE_MOIS);
  }
  if (compte.cycle) {
    e.enquete = ajouterJours(compte.cycle.debut, ENQUETE_JOUR + compte.cycle.decalage);
    e.decision = ajouterJours(compte.cycle.debut, DECISION_JOUR + compte.cycle.decalage);
  }
  if (compte.veille) {
    e.prochaineEnquete = compte.veille.enquete ? null : compte.veille.prochaineEnquete;
    e.decisionEnquete = compte.veille.enquete ? compte.veille.enquete.decisionAt : null;
  }
  if (compte.verifRenforcee) e.finVerificationRenforcee = compte.verifRenforcee.fin;
  if (compte.presomption) e.finGrace = compte.presomption.graceFinAt;
  if (compte.pause) e.finPause = compte.pause.jusquau;
  if (compte.liquidation) e.finLiquidation = compte.liquidation.finAt;
  return e;
}
