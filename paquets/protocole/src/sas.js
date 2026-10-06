// Le sas d'exécution (architecture du socle, AD-12).
// Le passage à l'exécution exige cinq conditions vérifiées ensemble, par un
// chemin de code DISTINCT de celui qui a produit la décision : rien ici ne
// lit la machine à états ni ses dates calculées. Les verrous 1 à 4 relisent
// le journal événement par événement ; le verrou 5 rejoue tout le journal et
// compare le résultat à l'état projeté. Fonction pure.

import { ajouterJours, ajouterMois } from './horloge.js';
import { DELAIS } from './compte.js';
import { rejouer } from './moteur.js';

const REMISE_PROUVEE = new Set(['REMIS', 'OUVERT']);
const RESETS = new Set(['COMPTE_ARME', 'SIGNE_DE_VIE_S1', 'PRESOMPTION_ANNULEE']);

// JSON à clés triées : deux états égaux s'écrivent pareil, quel que soit
// l'ordre dans lequel leurs champs ont été créés.
export function canonique(valeur) {
  if (Array.isArray(valeur)) return `[${valeur.map(canonique).join(',')}]`;
  if (valeur && typeof valeur === 'object') {
    return `{${Object.keys(valeur).sort()
      .filter((k) => valeur[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonique(valeur[k])}`).join(',')}}`;
  }
  return JSON.stringify(valeur) ?? 'null';
}

// L'état d'un compte sans ce qui n'est pas de l'état : son journal (la
// source), sa fonction de hachage, l'instant de sa dernière évaluation.
export function projectionDe(compte) {
  const { journal, _hachage, dernierAsOf, ...reste } = compte;
  return reste;
}

const dernierIndex = (liste, predicat, depuis = 0) => {
  for (let i = liste.length - 1; i >= depuis; i--) if (predicat(liste[i])) return i;
  return -1;
};

/**
 * @param {{ journal: object[], projection: object, asOf: number, hachage?: Function }} p
 * @returns {{ ok: boolean, verrous: { n: number, nom: string, ok: boolean, detail: string }[], reessayerA: number|null }}
 */
export function verifierSas({ journal, projection, asOf, hachage }) {
  const verrous = [];
  const poser = (n, nom, ok, detail) => verrous.push({ n, nom, ok, detail });
  const iP = dernierIndex(journal, (e) => e.type === 'PRESOMPTION_DECES');
  const presomption = iP >= 0 ? journal[iP] : null;
  const avant = iP >= 0 ? journal.slice(0, iP) : journal;
  const apres = iP >= 0 ? journal.slice(iP + 1).filter((e) => e.at <= asOf) : [];
  const iReset = dernierIndex(avant, (e) => RESETS.has(e.type));
  const depuisReset = avant.slice(iReset + 1);
  let reessayerA = null;

  // 1 — 90 jours depuis l'ÉVÉNEMENT de présomption, pas depuis une date de l'état.
  if (!presomption) {
    poser(1, 'grâce écoulée', false, 'aucune présomption au journal');
  } else {
    const fin = ajouterJours(presomption.at, DELAIS.GRACE_JOURS);
    const ok = asOf >= fin;
    if (!ok) reessayerA = fin;
    poser(1, 'grâce écoulée', ok, `présomption journalisée le ${new Date(presomption.at).toISOString()}, grâce révolue le ${new Date(fin).toISOString()}`);
  }

  // 2 — aucun signe de vie depuis la présomption.
  const signes = apres.filter((e) => e.type === 'SIGNE_DE_VIE_S1' || e.type === 'PRESOMPTION_ANNULEE');
  poser(2, 'aucun S1 depuis la présomption', Boolean(presomption) && signes.length === 0,
    signes.length ? `${signes.length} signe(s) de vie après la présomption` : 'aucun');

  // 3 — quorum (contacts acceptants AUJOURD'HUI) ou plancher de 18 mois franchi.
  const acceptants = new Set();
  for (const e of journal) {
    if (e.at > asOf) break;
    if (e.type === 'CONTACT_ACCEPTANT') acceptants.add(e.donnees.id);
    if (e.type === 'CONTACT_RENONCE') acceptants.delete(e.donnees.id);
  }
  const attestations = depuisReset.filter((e) => e.type === 'ATTESTATION_RECUE' && acceptants.has(e.donnees.contactId));
  const attestants = new Set(attestations.map((e) => e.donnees.contactId));
  const quorum = attestants.size >= 2 || (acceptants.size === 1 && attestations.some((e) => e.donnees.piece));
  const iS1 = dernierIndex(avant, (e) => e.type === 'COMPTE_ARME' || e.type === 'SIGNE_DE_VIE_S1');
  let plancherFranchi = false;
  if (presomption && iS1 >= 0) {
    const neutralises = avant.slice(iS1 + 1).filter((e) => e.type === 'COMPTEURS_DECALES')
      .reduce((n, e) => n + e.donnees.jours, 0);
    const plancher = ajouterJours(ajouterMois(avant[iS1].at, DELAIS.PLANCHER_INACTIVITE_MOIS), neutralises);
    plancherFranchi = presomption.at >= plancher;
  }
  poser(3, 'quorum ou plancher', Boolean(presomption) && (quorum || plancherFranchi),
    `${attestants.size} attestant(s) parmi ${acceptants.size} acceptant(s) ; plancher ${plancherFranchi ? 'franchi' : 'non franchi'}`);

  // 4 — sollicitations effectivement REMISES sur deux canaux distincts (AD-13),
  // et enquête des contacts remise à au moins l'un d'eux s'il y en a eu une.
  const preuveActive = journal[0]?.donnees?.preuveDeRemise === true;
  const remisesProuvees = (type, depuisIndex, depuisDate) => new Set(depuisReset.slice(depuisIndex + 1)
    .filter((e) => e.type === 'REMISE_RECUE' && e.donnees.effet === type && REMISE_PROUVEE.has(e.donnees.resultat)
      && e.donnees.prevueLe >= depuisDate)
    .map((e) => e.donnees.canal));
  const iSoll = dernierIndex(depuisReset, (e) => e.type === 'SOLLICITATION_OUVERTE');
  const iVerif = dernierIndex(depuisReset, (e) => e.type === 'VERIFICATION_RENFORCEE_OUVERTE');
  let canaux = new Set();
  let phase = 'aucune sollicitation';
  if (iVerif > iSoll) {
    phase = 'relances renforcées';
    canaux = remisesProuvees('RELANCE_RENFORCEE', iVerif, depuisReset[iVerif].at);
  } else if (iSoll >= 0) {
    phase = 'sollicitations';
    canaux = remisesProuvees('SOLLICITATION', iSoll, depuisReset[iSoll].donnees.prevueLe);
  }
  const enquetes = depuisReset.filter((e) => e.type === 'CONTACTS_SOLLICITES' && e.donnees.contacts.length > 0);
  const enqueteRemise = journal.slice(iReset + 1).some((e) => e.at <= asOf && e.type === 'REMISE_RECUE'
    && e.donnees.effet === 'ENQUETE_CONTACT' && REMISE_PROUVEE.has(e.donnees.resultat));
  const contactsOk = enquetes.length === 0 || enqueteRemise;
  poser(4, 'remises prouvées', preuveActive && canaux.size >= 2 && contactsOk,
    !preuveActive ? 'compte sans preuve de remise'
      : `${phase} remises sur ${[...canaux].join(', ') || 'aucun canal'} ; enquête des contacts ${enquetes.length === 0 ? 'sans objet' : enqueteRemise ? 'remise' : 'jamais remise'}`);

  // 5 — l'état recalculé depuis le journal est celui que l'on s'apprête à exécuter.
  const rejeu = rejouer(journal, { hachage });
  const identique = rejeu.ok && canonique(projectionDe(rejeu.etat)) === canonique(projectionDe(projection));
  poser(5, 'recalcul identique', identique, rejeu.ok ? (identique ? 'identique' : 'la projection diffère du rejeu') : rejeu.motif);

  const ok = verrous.every((v) => v.ok);
  // On ne réessaie plus tard que si seul le temps manque.
  const seulLeTemps = !ok && verrous.filter((v) => !v.ok).every((v) => v.n === 1) && reessayerA != null;
  return { ok, verrous, reessayerA: seulLeTemps ? reessayerA : null };
}
