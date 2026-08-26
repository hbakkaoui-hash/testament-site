// Contacts de confiance — BR-A-11 à BR-A-17 de la spécification v0.1.
// Acceptation explicite, renonciation libre, 5 au maximum. Un contact n'a
// jamais accès aux contenus ni aux destinataires — le module n'expose
// d'ailleurs aucune API dans ce sens (BR-A-12).

import { consigner } from './journal.js';

const CONTACTS_MAX = 5; // BR-A-15

function noterCompte(compte, at, type, donnees) {
  consigner(compte.journal, { at, type, donnees }, compte._hachage);
}

export function contactsAcceptants(compte) {
  return compte.contacts.filter((c) => c.statut === 'ACCEPTANT');
}

export function inviterContact(compte, { id, nom, email, at }) {
  const comptabilises = compte.contacts.filter((c) => c.statut !== 'RENONCE');
  if (comptabilises.length >= CONTACTS_MAX) throw new Error('5 contacts de confiance maximum (BR-A-15)');
  if (compte.contacts.some((c) => c.id === id && c.statut !== 'RENONCE')) throw new Error('contact déjà invité');
  compte.contacts.push({ id, nom, email, statut: 'EN_ATTENTE', inviteLe: at });
  noterCompte(compte, at, 'CONTACT_INVITE', { id });
}

// BR-A-11 : tant qu'il n'a pas accepté, il n'est pas comptabilisé dans le quorum.
export function accepterInvitation(compte, { id, at }) {
  const contact = compte.contacts.find((c) => c.id === id && c.statut === 'EN_ATTENTE');
  if (!contact) throw new Error('invitation introuvable');
  contact.statut = 'ACCEPTANT';
  contact.accepteLe = at;
  noterCompte(compte, at, 'CONTACT_ACCEPTANT', { id });
}

export function refuserInvitation(compte, { id, at }) {
  const index = compte.contacts.findIndex((c) => c.id === id && c.statut === 'EN_ATTENTE');
  if (index === -1) throw new Error('invitation introuvable');
  compte.contacts.splice(index, 1); // purge immédiate des données du tiers
  noterCompte(compte, at, 'CONTACT_REFUS_PURGE', { id });
}

// BR-A-13 : renonciation à tout moment, sans justification, testateur informé.
export function renoncerContact(compte, { id, at }) {
  const contact = compte.contacts.find((c) => c.id === id && c.statut === 'ACCEPTANT');
  if (!contact) throw new Error('contact acceptant introuvable');
  contact.statut = 'RENONCE';
  contact.renonceLe = at;
  noterCompte(compte, at, 'CONTACT_RENONCE', { id, testateurNotifie: true });
}
