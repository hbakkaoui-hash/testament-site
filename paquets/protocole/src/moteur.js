// Point d'entrée unique du protocole (architecture du socle, AD-2) :
//   evaluer(etat, entrees, asOf) → { etat, evenements, effets, prochaineEcheance }
// Fonction pure : l'état reçu n'est jamais modifié, rien n'est lu ni écrit
// hors des arguments. Le moteur DEMANDE des effets (envois, exécution) ; une
// couche extérieure les exécute, une seule fois grâce à leur clé (AD-11).
// Le temps est une entrée (AP-1) : `asOf` et l'horodatage serveur de chaque
// entrée, jamais l'horloge du client (AD-4).

import {
  signalS1, signalS2, attesterDeces, repondreEnquete, demarrerPause,
  renouvelerPause, changerCadence, tick, prochaineEcheance,
} from './compte.js';
import { consigner } from './journal.js';

/**
 * @typedef {number} Instant  millisecondes UTC
 * @typedef {{ type: 'S1', at?: Instant, signal?: 'CONNEXION'|'LIEN_SIGNE'|'ACTION_APP' }
 *   | { type: 'S2', at?: Instant, signal?: string, explicite?: boolean }
 *   | { type: 'ATTESTATION', at?: Instant, contactId: string, piece?: unknown }
 *   | { type: 'REPONSE_ENQUETE', at?: Instant, contactId: string, reponse: 'VIVANT'|'DECEDE'|'NSP', piece?: unknown }
 *   | { type: 'ABSENCE', at?: Instant, jusquau: Instant, auth: object }
 *   | { type: 'RENOUVELLEMENT_ABSENCE', at?: Instant, jusquau: Instant, auth: object }
 *   | { type: 'CADENCE', at?: Instant, cadenceMois: number, auth?: object }} Entree
 * @typedef {{ cle: string, type: string, at: Instant, [k: string]: unknown }} Effet
 * @typedef {{ etat: object, evenements: object[], effets: Effet[],
 *   prochaineEcheance: Instant|null, rejets: { entree: Entree, motif: string }[],
 *   anomalie?: { code: string, detail: string } }} Resultat
 */

const APPLIQUER = {
  S1: (c, e) => signalS1(c, { type: e.signal ?? 'CONNEXION', at: e.at }),
  S2: (c, e) => signalS2(c, { type: e.signal ?? 'OUVERTURE_EMAIL', at: e.at, explicite: e.explicite === true }),
  ATTESTATION: (c, e) => attesterDeces(c, { contactId: e.contactId, piece: e.piece ?? null, at: e.at }),
  REPONSE_ENQUETE: (c, e) => repondreEnquete(c, { contactId: e.contactId, reponse: e.reponse, piece: e.piece ?? null, at: e.at }),
  ABSENCE: (c, e) => demarrerPause(c, { jusquau: e.jusquau, at: e.at, auth: e.auth }),
  RENOUVELLEMENT_ABSENCE: (c, e) => renouvelerPause(c, { jusquau: e.jusquau, at: e.at, auth: e.auth }),
  CADENCE: (c, e) => changerCadence(c, { cadenceMois: e.cadenceMois, at: e.at, auth: e.auth }),
};

// Copie profonde ; la fonction de hachage éventuelle est partagée, pas copiée.
function clonerEtat(etat) {
  const { _hachage, ...reste } = etat;
  const copie = structuredClone(reste);
  copie._hachage = _hachage;
  return copie;
}

/**
 * @param {object} etat      état du compte (non modifié)
 * @param {Entree[]} entrees faits survenus depuis la dernière évaluation
 * @param {Instant} asOf     instant d'évaluation, horloge serveur UTC
 * @returns {Resultat}
 */
export function evaluer(etat, entrees, asOf) {
  if (!Number.isFinite(asOf)) throw new TypeError('evaluer : asOf doit être un instant en millisecondes UTC');

  // Anti-régression d'horloge (AD-6) : le moteur ne revient jamais en arrière.
  if (etat.dernierAsOf != null && asOf < etat.dernierAsOf) {
    const anomalie = { code: 'ASOF_REGRESSIF', detail: `asOf ${asOf} antérieur au dernier ${etat.dernierAsOf}` };
    return {
      etat, evenements: [], rejets: [], anomalie,
      effets: [{ cle: `${etat.id}:ALERTE:ASOF_REGRESSIF:${asOf}`, type: 'ALERTE_EXPLOITATION', at: asOf, motif: anomalie.code }],
      prochaineEcheance: prochaineEcheance(etat),
    };
  }

  const compte = clonerEtat(etat);
  const debut = compte.journal.length;
  const plancher = etat.dernierAsOf ?? -Infinity;
  const rejets = [];

  // Les entrées sont rejouées dans l'ordre de leur horodatage serveur, et le
  // protocole est d'abord amené à chacun de ces instants : un signe de vie
  // reçu après une échéance ne l'efface pas rétroactivement.
  const triees = (entrees ?? [])
    .map((e, rang) => ({ ...e, at: e.at ?? asOf, rang }))
    .sort((a, b) => a.at - b.at || a.rang - b.rang);

  for (const { rang, ...entree } of triees) {
    let motif = null;
    if (!(entree.type in APPLIQUER)) motif = `type d'entrée inconnu : ${entree.type}`;
    else if (entree.at > asOf || entree.at < plancher) motif = 'horodatage hors de la fenêtre évaluée';
    if (!motif) {
      tick(compte, entree.at);
      try {
        APPLIQUER[entree.type](compte, entree);
      } catch (err) {
        motif = err.message;
      }
    }
    if (motif) {
      rejets.push({ entree, motif });
      const at = Number.isFinite(entree.at) && entree.at <= asOf && entree.at >= plancher ? entree.at : asOf;
      consigner(compte.journal, { at, type: 'ENTREE_REFUSEE', donnees: { entree: entree.type, motif } }, compte._hachage);
    }
  }

  tick(compte, asOf);
  compte.dernierAsOf = asOf;

  const evenements = compte.journal.slice(debut);
  return {
    etat: compte,
    evenements,
    effets: evenements.flatMap((e) => effetsDe(compte, e)),
    prochaineEcheance: prochaineEcheance(compte),
    rejets,
  };
}

// Traduction des faits journalisés en effets demandés. La clé d'idempotence
// ne dépend que de la date prévue par le protocole, jamais de l'instant où
// l'évaluation a eu lieu : un rejeu, même découpé autrement, redonne les
// mêmes clés (AD-11).
function effetsDe(compte, e) {
  const d = e.donnees;
  const id = compte.id;
  switch (e.type) {
    case 'SOLLICITATION_ENVOYEE':
      return d.canaux.map((canal) => ({
        cle: `${id}:SOLLICITATION:${d.niveau}:${canal}:${d.prevueLe}`,
        type: 'SOLLICITATION', at: e.at, niveau: d.niveau, canal, prevueLe: d.prevueLe,
      }));
    case 'RELANCE_RENFORCEE':
      return d.canaux.map((canal) => ({
        cle: `${id}:RELANCE_RENFORCEE:${d.numero}:${canal}:${d.prevueLe}`,
        type: 'RELANCE_RENFORCEE', at: e.at, numero: d.numero, canal, prevueLe: d.prevueLe,
      }));
    case 'RELANCE_GRACE':
      return d.canaux.map((canal) => ({
        cle: `${id}:RELANCE_GRACE:${d.numero}:${canal}:${d.prevueLe}`,
        type: 'RELANCE_GRACE', at: e.at, numero: d.numero, canal, prevueLe: d.prevueLe,
      }));
    case 'CONTACTS_SOLLICITES':
      return d.contacts.map((contactId) => ({
        cle: `${id}:ENQUETE_CONTACT:${contactId}:${d.prevueLe}`,
        type: 'ENQUETE_CONTACT', at: e.at, contactId, prevueLe: d.prevueLe,
      }));
    case 'ATTESTANTS_COMMUNIQUES': // BR-A-17
      return [{ cle: `${id}:ATTESTANTS_COMMUNIQUES:${e.at}`, type: 'INFORMER_TESTATEUR', at: e.at, contacts: d.contacts }];
    case 'EXECUTION_DEMARREE':
      // Une demande, pas un déclenchement : le sas d'exécution (AD-12) et la
      // confirmation humaine (AD-15) se tiennent entre cet effet et le premier pli.
      return [{ cle: `${id}:DEMANDE_EXECUTION:${d.prevueLe}`, type: 'DEMANDE_EXECUTION', at: e.at, prevueLe: d.prevueLe }];
    default:
      return [];
  }
}
