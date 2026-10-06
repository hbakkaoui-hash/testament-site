// Point d'entrée unique du protocole (architecture du socle, AD-2) :
//   evaluer(etat, entrees, asOf) → { etat, evenements, effets, prochaineEcheance }
// Fonction pure : l'état reçu n'est jamais modifié, rien n'est lu ni écrit
// hors des arguments. Le moteur DEMANDE des effets (envois, exécution) ; une
// couche extérieure les exécute, une seule fois grâce à leur clé (AD-11).
// Le temps est une entrée (AP-1) : `asOf` et l'horodatage serveur de chaque
// entrée, jamais l'horloge du client (AD-4).
//
// Le journal se suffit à lui-même (AP-3) : toute évaluation qui change quelque
// chose y inscrit d'abord une entrée EVALUATION portant ses entrées et son
// instant. `rejouer(journal)` refait ces évaluations depuis la création du
// compte et redonne le même état, empreinte pour empreinte.

import {
  creerCompte, armer, desarmer, signalS1, signalS2, attesterDeces, repondreEnquete,
  demarrerPause, renouvelerPause, changerCadence, constaterIndisponibilite, avancerProtocole, prochaineEcheance,
  noterRemise, confirmerExecution,
} from './compte.js';
import { inviterContact, accepterInvitation, refuserInvitation, renoncerContact } from './contacts.js';
import { consigner } from './journal.js';

/**
 * @typedef {number} Instant  millisecondes UTC
 * @typedef {{ type: 'S1', at?: Instant, signal?: 'CONNEXION'|'LIEN_SIGNE'|'ACTION_APP' }
 *   | { type: 'S2', at?: Instant, signal?: string, explicite?: boolean }
 *   | { type: 'ATTESTATION', at?: Instant, contactId: string, piece?: unknown }
 *   | { type: 'REPONSE_ENQUETE', at?: Instant, contactId: string, reponse: 'VIVANT'|'DECEDE'|'NSP', piece?: unknown }
 *   | { type: 'ABSENCE', at?: Instant, jusquau: Instant, auth: object }
 *   | { type: 'RENOUVELLEMENT_ABSENCE', at?: Instant, jusquau: Instant, auth: object }
 *   | { type: 'CADENCE', at?: Instant, cadenceMois: number, auth?: object }
 *   | { type: 'ARMER', at?: Instant, auth: object, canauxVerifies: number, messagesScelles: number, accuseLecture: boolean }
 *   | { type: 'DESARMER', at?: Instant, auth: object }
 *   | { type: 'INVITER_CONTACT'|'ACCEPTER_CONTACT'|'REFUSER_CONTACT'|'RENONCER_CONTACT', at?: Instant, contactId: string }
 *   | { type: 'INDISPONIBILITE', at?: Instant, id: string, debut: Instant, fin: Instant, cause?: string }
 *   | { type: 'REMISE', at?: Instant, effet: { type: string, canal?: string, contactId?: string, prevueLe?: Instant }, resultat: 'REMIS'|'OUVERT'|'REBOND' }
 *   | { type: 'CONFIRMATION_EXECUTION', at?: Instant, par: string }} Entree
 * Les entrées ne portent que des faits et des identifiants : le nom et
 * l'adresse d'un contact vivent hors du moteur, jamais dans le journal.
 * @typedef {{ rattrapage?: { operateur: string, motif: string } }} Options
 *   `rattrapage` : levée nominative du garde-fou d'AD-9 par un opérateur.
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
  ARMER: (c, e) => armer(c, {
    at: e.at, auth: e.auth, canauxVerifies: e.canauxVerifies, messagesScelles: e.messagesScelles, accuseLecture: e.accuseLecture,
  }),
  DESARMER: (c, e) => desarmer(c, { at: e.at, auth: e.auth }),
  INVITER_CONTACT: (c, e) => inviterContact(c, { id: e.contactId, at: e.at }),
  ACCEPTER_CONTACT: (c, e) => accepterInvitation(c, { id: e.contactId, at: e.at }),
  REFUSER_CONTACT: (c, e) => refuserInvitation(c, { id: e.contactId, at: e.at }),
  RENONCER_CONTACT: (c, e) => renoncerContact(c, { id: e.contactId, at: e.at }),
  INDISPONIBILITE: (c, e) => constaterIndisponibilite(c, { id: e.id, debut: e.debut, fin: e.fin, cause: e.cause, at: e.at }),
  REMISE: (c, e) => noterRemise(c, { effet: e.effet, resultat: e.resultat, at: e.at }),
  CONFIRMATION_EXECUTION: (c, e) => confirmerExecution(c, { par: e.par, at: e.at }),
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
 * @param {Options} [options]
 * @returns {Resultat}
 */
export function evaluer(etat, entrees, asOf, options = {}) {
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

  // Les entrées sont figées en JSON dès l'arrivée : ce qui est journalisé est
  // exactement ce qui est appliqué, et un rejeu ne peut pas lire autre chose.
  const normalisees = JSON.parse(JSON.stringify(entrees ?? [])).map((e) => ({ ...e, at: e.at ?? asOf }));

  // Premier passage à blanc : une évaluation qui ne change rien ne laisse
  // aucune trace (l'ordonnanceur réveille souvent pour rien). Sinon, on
  // recommence en inscrivant d'abord l'évaluation elle-même au journal.
  let compte = clonerEtat(etat);
  let debut = compte.journal.length;
  let { rejets, transitions } = appliquerEntrees(compte, normalisees, asOf, etat.dernierAsOf);

  // Garde-fou du rattrapage (AD-9) : un compte ne franchit jamais d'un coup
  // deux étapes qui étaient dues à des instants différents — il aurait dû
  // vivre chacune, avec les sollicitations qui les séparent. On suspend, on
  // alerte ; seul un opérateur nommé peut autoriser le rattrapage.
  const instants = new Set(transitions.map((t) => t.du));
  if (instants.size > 1 && !options.rattrapage) {
    const anomalie = {
      code: 'RATTRAPAGE_MULTIPLE',
      detail: transitions.map((t) => `${t.de}→${t.vers}@${t.du}`).join(' ; '),
    };
    return {
      etat, evenements: [], rejets: [], anomalie,
      effets: [{ cle: `${etat.id}:ALERTE:RATTRAPAGE_MULTIPLE:${asOf}`, type: 'ALERTE_EXPLOITATION', at: asOf, motif: anomalie.code }],
      prochaineEcheance: prochaineEcheance(etat),
    };
  }

  if (compte.journal.length > debut) {
    compte = clonerEtat(etat);
    debut = compte.journal.length;
    // Datée du plus ancien fait qu'elle applique, pour que le journal reste
    // chronologique ; son instant d'évaluation est dans `asOf`.
    const dates = normalisees.map((e) => e.at)
      .filter((t) => Number.isFinite(t) && t <= asOf && t >= (etat.dernierAsOf ?? -Infinity));
    consigner(compte.journal, {
      at: Math.min(asOf, ...dates),
      type: 'EVALUATION',
      donnees: {
        asOf, depuis: etat.dernierAsOf ?? null, entrees: normalisees,
        ...(options.rattrapage ? { rattrapage: JSON.parse(JSON.stringify(options.rattrapage)) } : {}),
      },
    }, compte._hachage);
    ({ rejets } = appliquerEntrees(compte, normalisees, asOf, etat.dernierAsOf));
  }
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

// Les entrées sont rejouées dans l'ordre de leur horodatage serveur, et le
// protocole est d'abord amené à chacun de ces instants : un signe de vie reçu
// après une échéance ne l'efface pas rétroactivement.
function appliquerEntrees(compte, entrees, asOf, dernierAsOf) {
  const plancher = dernierAsOf ?? -Infinity;
  const rejets = [];
  const transitions = [];
  const avancerJusqua = (t) => transitions.push(...avancerProtocole(compte, t).transitions);
  const triees = entrees.map((e, rang) => ({ e, rang })).sort((a, b) => a.e.at - b.e.at || a.rang - b.rang);
  for (const { e: entree } of triees) {
    let motif = null;
    if (!Object.hasOwn(APPLIQUER, entree.type)) motif = `type d'entrée inconnu : ${entree.type}`;
    else if (!Number.isFinite(entree.at) || entree.at > asOf || entree.at < plancher) motif = 'horodatage hors de la fenêtre évaluée';
    if (!motif) {
      avancerJusqua(entree.at);
      try {
        APPLIQUER[entree.type](compte, entree);
      } catch (err) {
        motif = err.message;
      }
    }
    if (motif) {
      rejets.push({ entree, motif });
      const at = Number.isFinite(entree.at) && entree.at <= asOf && entree.at >= plancher ? entree.at : asOf;
      consigner(compte.journal, { at, type: 'ENTREE_REFUSEE', donnees: { entree: String(entree.type), motif } }, compte._hachage);
    }
  }
  avancerJusqua(asOf);
  return { rejets, transitions };
}

// Ouverture d'un compte : la seule écriture qui ne passe pas par `evaluer`,
// parce qu'il n'y a encore rien à évaluer. Son entrée COMPTE_CREE est la
// genèse du journal.
// Les garde-fous serveur y sont actifs par défaut (AD-12, AD-13).
export function ouvrirCompte({ id, at, cadenceMois = 6, hachage, preuveDeRemise = true, sasExecution = true } = {}) {
  const compte = creerCompte({ id, at, cadenceMois, hachage, preuveDeRemise, sasExecution });
  compte.dernierAsOf = at;
  return compte;
}

// Reconstruit un compte depuis son seul journal (AP-3, lot 2) : la genèse,
// puis chaque évaluation rejouée avec ses entrées et son instant. Toute entrée
// que le rejeu ne reproduit pas à l'identique est une divergence — code
// modifié, journal altéré ou entrée glissée hors du moteur.
export function rejouer(journal, { hachage } = {}) {
  const genese = journal[0];
  if (!genese || genese.type !== 'COMPTE_CREE') {
    return { ok: false, seq: genese ? genese.seq : 0, motif: 'le journal ne commence pas par COMPTE_CREE' };
  }
  const d = genese.donnees;
  let compte = ouvrirCompte({
    id: d.id, at: genese.at, cadenceMois: d.cadenceMois, hachage,
    preuveDeRemise: d.preuveDeRemise === true, sasExecution: d.sasExecution === true,
  });
  let i = 0;
  const comparer = (jusqua) => {
    for (; i < jusqua; i++) {
      const attendu = journal[i];
      const obtenu = compte.journal[i];
      if (!attendu || !obtenu || attendu.empreinte !== obtenu.empreinte) return false;
    }
    return true;
  };
  if (!comparer(1)) return { ok: false, seq: 0, motif: 'genèse non reproduite' };
  const effets = []; // tous les effets jamais demandés : de quoi éprouver la file (lot 4)
  while (i < journal.length) {
    const ev = journal[i];
    if (ev.type !== 'EVALUATION') {
      return { ok: false, seq: ev.seq, motif: `entrée ${ev.type} sans évaluation qui la produise` };
    }
    const { asOf, depuis, entrees, rattrapage } = ev.donnees;
    compte.dernierAsOf = depuis;
    const r = evaluer(compte, entrees, asOf, rattrapage ? { rattrapage } : {});
    compte = r.etat;
    effets.push(...r.effets);
    if (compte.journal.length <= i || !comparer(compte.journal.length)) {
      return { ok: false, seq: journal[i] ? journal[i].seq : ev.seq, motif: 'le rejeu ne reproduit pas le journal' };
    }
  }
  return { ok: true, etat: compte, effets };
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
    case 'EXECUTION_DEMANDEE':
      // Une demande, pas un déclenchement : le sas d'exécution (AD-12) et la
      // confirmation humaine (AD-15) se tiennent entre cet effet et le démarrage.
      return [{ cle: `${id}:DEMANDE_EXECUTION:${d.prevueLe}`, type: 'DEMANDE_EXECUTION', at: e.at, prevueLe: d.prevueLe }];
    case 'EXECUTION_DEMARREE':
      if (d.confirmePar) { // passé par le sas : le module D peut préparer les plis
        return [{
          cle: `${id}:EXECUTION_AUTORISEE:${d.prevueLe}`, type: 'EXECUTION_AUTORISEE', at: e.at, prevueLe: d.prevueLe, confirmePar: d.confirmePar,
        }];
      }
      // Prototype sans sas : la demande part au même instant que le démarrage.
      return [{ cle: `${id}:DEMANDE_EXECUTION:${d.prevueLe}`, type: 'DEMANDE_EXECUTION', at: e.at, prevueLe: d.prevueLe }];
    case 'REMISE_INSUFFISANTE': // AD-13 : se tait-il, ou n'a-t-on pas su lui parler ?
      return [{
        cle: `${id}:ALERTE:REMISE_INSUFFISANTE:${d.phase}:${d.prevueLe}`, type: 'ALERTE_EXPLOITATION', at: e.at,
        motif: 'REMISE_INSUFFISANTE', phase: d.phase, canauxRemis: d.canauxRemis,
      }];
    default:
      return [];
  }
}
