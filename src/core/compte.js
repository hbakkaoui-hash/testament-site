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
const CANAUX = ['email', 'email2', 'push', 'sms'];

const SIGNAUX_S1 = new Set(['CONNEXION', 'LIEN_SIGNE', 'ACTION_APP']); // S1 — preuve forte
const ETATS_IRREVERSIBLES = [ETATS.EN_EXECUTION, ETATS.EXECUTE, ETATS.EN_LIQUIDATION, ETATS.SUPPRIME];
const ETATS_PROTOCOLE = [ETATS.ARME, ETATS.SOLLICITATION, ETATS.ENQUETE, ETATS.VEILLE_LONGUE, ETATS.PRESUME_DECEDE];

export function creerCompte({ id, at, cadenceMois = 6, hachage } = {}) {
  if (!CADENCES_MOIS.includes(cadenceMois)) {
    throw new Error(`cadence de check-in parmi ${CADENCES_MOIS.join('/')} mois (4.2)`);
  }
  const compte = {
    id,
    creeLe: at,
    etat: ETATS.NOUVEAU,
    regles: { cadenceMois },
    armement: null,        // { at, canauxVerifies, messagesScelles }
    derniereS1: null,
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
  noterCompte(compte, at, 'COMPTE_CREE', { cadenceMois });
  return compte;
}

function noterCompte(compte, at, type, donnees = {}) {
  consigner(compte.journal, { at, type, donnees }, compte._hachage);
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
      compte.verifRenforcee = { debut: at, fin: ajouterJours(at, VERIF_RENFORCEE_JOURS), relancesEmises: 0, signal: false };
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
  if (compte.derniereS1 != null) compte.derniereS1 = ajouterJours(compte.derniereS1, jours);
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

// ————————————————————————————————————————————————— moteur d'échéances

function ouvrirSollicitation(compte, debut, at, motif) {
  compte.cycle = { debut, decalage: 0, s2Utilise: false, relances: 0, enqueteOuverte: false };
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
      compte.verifRenforcee = null;
      if (quorumAtteint(compte) && !v.signal) {
        ouvrirPresomption(compte, v.fin, at, 'ACCELEREE');
      } else {
        ouvrirSollicitation(compte, v.fin, at, 'SORTIE_VERIFICATION_RENFORCEE');
      }
      return true;
    }
    return false;
  }

  // Échéance de cadence → Phase 1
  if (compte.etat === ETATS.ARME && compte.derniereS1 != null) {
    const echeance = ajouterMois(compte.derniereS1, compte.regles.cadenceMois);
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
      c.enqueteOuverte = true;
      compte.etat = ETATS.ENQUETE;
      noterCompte(compte, at, 'CONTACTS_SOLLICITES', {
        contacts: contactsAcceptants(compte).map((x) => x.id),
        prevueLe: quandEnquete,
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
          plancherInactivite: ajouterMois(compte.derniereS1, PLANCHER_INACTIVITE_MOIS),
        });
      }
      return true;
    }
    return false;
  }

  // Veille longue : ré-enquêtes semestrielles, plancher de 18 mois (BR-C-05)
  if (compte.veille) {
    const v = compte.veille;
    const plancher = ajouterMois(compte.derniereS1, PLANCHER_INACTIVITE_MOIS);
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
    if (at >= p.graceFinAt) {
      compte.etat = ETATS.EN_EXECUTION;
      noterCompte(compte, at, 'EXECUTION_DEMARREE', { grace: `${GRACE_JOURS} jours révolus` });
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

// Évalue toutes les transitions dues à l'instant `at` (cascade en un appel).
export function tick(compte, at) {
  const avant = compte.journal.length;
  let garde = 0;
  while (etape(compte, at) && garde++ < 500) { /* cascade */ }
  return compte.journal.slice(avant);
}

// Fin de la vague immédiate (module D) → liquidation (module E).
export function terminerExecution(compte, { at }) {
  if (compte.etat !== ETATS.EN_EXECUTION) throw new Error('aucune exécution en cours');
  compte.etat = ETATS.EN_LIQUIDATION;
  compte.liquidation = { finAt: ajouterJours(at, LIQUIDATION_JOURS) };
  noterCompte(compte, at, 'EXECUTION_TERMINEE', {});
  noterCompte(compte, at, 'LIQUIDATION_OUVERTE', { finAt: compte.liquidation.finAt });
}

// Tableau de bord de statut (BR-C-11).
export function prochainesEcheances(compte) {
  const e = {};
  if (compte.derniereS1 != null && ETATS_PROTOCOLE.includes(compte.etat)) {
    e.echeanceCadence = ajouterMois(compte.derniereS1, compte.regles.cadenceMois);
    e.plancherInactivite = ajouterMois(compte.derniereS1, PLANCHER_INACTIVITE_MOIS);
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
