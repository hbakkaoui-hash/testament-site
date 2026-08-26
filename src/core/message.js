// Cycle de vie d'un message — module B de la spécification v0.1 (MVP : privé
// uniquement, A-2). Un scellé reste modifiable : chaque scellement produit une
// version, seule la dernière version scellée est délivrée (BR-B-05), et une
// version de moins de 24 h n'est pas exécutable (BR-B-09).

import { ajouterJours, ajouterMois } from './horloge.js';

export const ETATS_MESSAGE = Object.freeze({
  BROUILLON: 'BROUILLON',
  SCELLE: 'SCELLE',
});

const TEXTE_MAX = 50_000;             // BR-B-06
const IMAGES_MAX = 20;                // BR-B-06
const NOTE_MAX = 200;                 // BR-B-07
const MESSAGES_MAX_COMPTE = 200;      // BR-B-06
const OCTETS_MAX_COMPTE = 5 * 1024 ** 3; // BR-B-06 : 5 Go
const SCELLEMENT_DELAI_JOURS = 1;     // BR-B-09 : exécutable après 24 h
const DIFFERE_MAX_MOIS = 25 * 12;     // BR-B-19

export function creerMessage({ id, auteurId, titre, at }) {
  if (!titre || !titre.trim()) throw new Error('titre interne obligatoire (BR-B-02)');
  return {
    id,
    auteurId,
    titre, // visible du seul testateur (BR-B-02)
    creeLe: at,
    etat: ETATS_MESSAGE.BROUILLON,
    travail: {
      texte: '',
      images: [],        // { nom, octets }
      note: '',          // BR-B-07 : affichée au sas, non chiffrée
      fortImpact: false, // BR-B-08 : déclenche le parcours renforcé (BR-D-13)
      visibilite: 'PRIVE',        // BR-B-16 : privé par défaut, sans exception
      autorisationPublique: null, // { cocheLe, confirmeLe, attribution, indexable }
      publication: { mode: 'A_EXECUTION', dateFixe: null }, // BR-B-18 — une date
                                  // fixe peut tomber du vivant du testateur (§7.4)
      destinataires: [], // BR-B-10
      secours: null,     // BR-B-13
      delivrance: { mode: 'IMMEDIATE', dateFixe: null }, // BR-B-18
    },
    versions: [], // { numero, scelleLe, executableAt, contenu figé } — BR-B-05
  };
}

export function definirTexte(msg, texte) {
  if (texte.length > TEXTE_MAX) throw new Error('texte limité à 50 000 caractères (BR-B-06)');
  msg.travail.texte = texte;
}

export function ajouterImage(msg, { nom, octets }) {
  if (msg.travail.images.length >= IMAGES_MAX) throw new Error('20 images par message maximum (BR-B-06)');
  msg.travail.images.push({ nom, octets });
}

export function ajouterVideo() {
  throw new Error('vidéo et audio prévus en V2 (BR-B-01)');
}

// BR-B-07 : note d'introduction lisible par le service, montrée au destinataire
// AVANT qu'il n'ouvre le message. C'est le seul texte du message que le sas affiche.
export function definirNote(msg, note) {
  if (note.length > NOTE_MAX) throw new Error("note d'introduction limitée à 200 caractères (BR-B-07)");
  msg.travail.note = note;
}

// BR-B-08 : marquage « à fort impact » → sas renforcé côté destinataire.
export function marquerFortImpact(msg, valeur = true) {
  msg.travail.fortImpact = Boolean(valeur);
}

// ————————————————————————————————— publication publique (BR-B-16/17, BR-D-18/19)
// Consentement en deux temps, par message, jamais pré-coché, horodaté. Aucun
// réglage global ne peut rendre des messages publics en masse (BR-B-17) : ces
// fonctions ne prennent qu'un message à la fois, c'est délibéré.

const ATTRIBUTIONS = ['NOM_COMPLET', 'PRENOM', 'PSEUDONYME', 'ANONYME']; // BR-D-18

export function demanderPublication(msg, at) {
  msg.travail.autorisationPublique = { cocheLe: at, confirmeLe: null, attribution: null, indexable: false };
}

export function confirmerPublication(msg, { at, attribution = 'PRENOM', indexable = false }) {
  const a = msg.travail.autorisationPublique;
  if (!a || !a.cocheLe) throw new Error("cocher l'autorisation de publication avant de la confirmer (BR-B-16)");
  if (!ATTRIBUTIONS.includes(attribution)) throw new Error(`attribution parmi : ${ATTRIBUTIONS.join(', ')} (BR-D-18)`);
  a.confirmeLe = at;
  a.attribution = attribution;
  a.indexable = Boolean(indexable); // case DISTINCTE de l'autorisation (BR-D-19)
  msg.travail.visibilite = 'PUBLIC';
}

export function revoquerPublication(msg) {
  msg.travail.autorisationPublique = null;
  msg.travail.visibilite = 'PRIVE';
  msg.travail.publication = { mode: 'A_EXECUTION', dateFixe: null };
}

// BR-B-18 : « à l'exécution » (défaut) ou à une date fixe — y compris une date
// antérieure au décès : le testateur peut choisir de parler au monde de son vivant.
export function programmerPublication(msg, { mode, dateTs = null, at }) {
  if (msg.travail.visibilite !== 'PUBLIC') throw new Error('message privé : rien à publier (BR-B-16)');
  if (mode === 'A_EXECUTION') {
    msg.travail.publication = { mode, dateFixe: null };
    return;
  }
  if (mode !== 'DATE_FIXE') throw new Error('mode de publication : A_EXECUTION ou DATE_FIXE');
  if (dateTs == null || dateTs <= at) throw new Error('date de publication déjà passée (BR-B-18)');
  if (dateTs > ajouterMois(at, DIFFERE_MAX_MOIS)) throw new Error('publication différée limitée à 25 ans (BR-B-19)');
  msg.travail.publication = { mode, dateFixe: dateTs };
}

export function ajouterDestinataire(msg, {
  prenomNom, email, tel = null, langue = 'fr', relation = null,
  mineur = false, adulteReferent = null,
}) {
  if (!email) throw new Error('email du destinataire obligatoire (BR-B-10)');
  msg.travail.destinataires.push({ prenomNom, email, tel, langue, relation, mineur, adulteReferent });
}

// BR-B-13 : destinataire de secours, par message.
export function definirSecours(msg, { prenomNom, email, tel = null, langue = 'fr' }) {
  if (!email) throw new Error('email du destinataire de secours obligatoire (BR-B-13)');
  msg.travail.secours = { prenomNom, email, tel, langue };
}

// BR-B-18/19 : MVP = immédiat (défaut) ou date fixe, horizon 25 ans.
export function programmerDateFixe(msg, dateTs, at) {
  if (dateTs <= at) throw new Error('date de délivrance déjà passée (BR-B-18)');
  if (dateTs > ajouterMois(at, DIFFERE_MAX_MOIS)) {
    throw new Error('délivrance différée limitée à 25 ans (BR-B-19)');
  }
  msg.travail.delivrance = { mode: 'DATE_FIXE', dateFixe: dateTs };
}

export function revenirImmediate(msg) {
  msg.travail.delivrance = { mode: 'IMMEDIATE', dateFixe: null };
}

// Scellement explicite (BR-B-04) : fige une version.
export function sceller(msg, at) {
  const t = msg.travail;
  if (t.texte.trim() === '' && t.images.length === 0) throw new Error('contenu vide : rien à sceller');
  if (t.visibilite === 'PUBLIC') {
    if (!t.autorisationPublique || !t.autorisationPublique.confirmeLe) {
      throw new Error('autorisation de publication non confirmée (BR-B-16)');
    }
  } else if (t.destinataires.length === 0) {
    throw new Error('au moins un destinataire (BR-B-02)');
  }
  for (const d of t.destinataires) {
    // BR-B-14 : mineur → adulte référent ET date de délivrance fixée, sans exception.
    if (d.mineur && (!d.adulteReferent || t.delivrance.mode !== 'DATE_FIXE')) {
      throw new Error('destinataire mineur : adulte référent et date de délivrance obligatoires (BR-B-14)');
    }
  }
  const version = {
    numero: msg.versions.length + 1,
    scelleLe: at,
    executableAt: ajouterJours(at, SCELLEMENT_DELAI_JOURS), // BR-B-09
    texte: t.texte,
    images: t.images.map((i) => ({ ...i })),
    note: t.note,
    fortImpact: t.fortImpact,
    destinataires: t.destinataires.map((d) => ({ ...d })),
    secours: t.secours ? { ...t.secours } : null,
    delivrance: { ...t.delivrance },
    visibilite: t.visibilite,
    autorisationPublique: t.autorisationPublique ? { ...t.autorisationPublique } : null,
    publication: { ...t.publication },
  };
  msg.versions.push(version);
  msg.etat = ETATS_MESSAGE.SCELLE;
  return version;
}

// Sélection à l'exécution : seule la dernière version scellée part (BR-B-05),
// les brouillons jamais (BR-B-03), une version de moins de 24 h reste en
// attente — elle n'est pas délivrée, et l'ancienne version non plus (BR-B-09).
export function pourExecution(messages, at) {
  const executables = [];
  const enAttente = [];
  const exclus = [];
  for (const msg of messages) {
    if (msg.versions.length === 0) {
      exclus.push({ message: msg, motif: 'BROUILLON' });
      continue;
    }
    const derniere = msg.versions[msg.versions.length - 1];
    if (derniere.visibilite === 'PUBLIC') {
      // Les publics suivent la file de modération, pas la délivrance (§5.3).
      exclus.push({ message: msg, motif: 'PUBLIC' });
      continue;
    }
    if (at < derniere.executableAt) {
      enAttente.push({ message: msg, motif: 'SCELLEMENT_RECENT', executableAt: derniere.executableAt });
      continue;
    }
    executables.push({ message: msg, version: derniere });
  }
  return { executables, enAttente, exclus };
}

// Quotas par compte (BR-B-06) : 200 messages, 5 Go.
export function verifierQuotasCompte(messages) {
  const octets = messages.reduce(
    (somme, m) => somme + m.travail.images.reduce((s, i) => s + i.octets, 0),
    0,
  );
  return {
    messages: messages.length,
    octets,
    conforme: messages.length <= MESSAGES_MAX_COMPTE && octets <= OCTETS_MAX_COMPTE,
  };
}
