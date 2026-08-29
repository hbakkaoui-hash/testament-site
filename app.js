// Application Testament — coquille locale au-dessus du noyau de domaine.
// Aucune règle métier ici : tout passe par src/core/. La persistance est un
// localStorage (M2 : à remplacer par une vraie API), et le temps est celui du
// « banc d'essai » pour pouvoir observer un protocole qui se joue sur des mois.

import {
  creerCompte, armer, signalS1, signalS2, attesterDeces, demarrerPause,
  changerCadence, tick, terminerExecution, prochainesEcheances, CADENCES_MOIS, ETATS,
} from './src/core/compte.js';
import {
  inviterContact, accepterInvitation, renoncerContact, refuserInvitation, contactsAcceptants,
} from './src/core/contacts.js';
import {
  creerMessage, definirTexte, definirNote, marquerFortImpact, ajouterDestinataire,
  definirSecours, programmerDateFixe, revenirImmediate, sceller, ajouterGroupe, groupesDe,
  demanderPublication, confirmerPublication, revoquerPublication, programmerPublication,
  ETATS_MESSAGE,
} from './src/core/message.js';
import {
  tickPublications, fileModeration, publicationsEnLigne, deciderModeration,
  signalerDetresse, demanderRetrait, retirerPublication, vuePublique, dateDuePublication,
} from './src/core/publication.js';
import {
  demarrerExecution, tickExecution, ouvrirSas, envoyerCode, verifierCode,
  lire, differer, refuser, telecharger, signalerRebond, ETATS_PLI,
} from './src/core/execution.js';
import {
  designerExecuteur, retirerExecuteur, reporterExecution, fenetreDeReport,
  demanderSuspension, confirmerSuspension, fournirCoordonnees, apercuPourExecuteur, POUVOIRS,
} from './src/core/executeur.js';
import {
  deposerReflexion, modererReflexion, reflexionsPubliques, fileModerationReflexions,
  definirReflexions, signalerContenu, fileSignalements, traiterSignalement,
} from './src/core/reflexions.js';
import {
  tickDonnees, definirDirectivePublique, demanderSuppressionCompte,
  annulerSuppressionCompte, exporter, etatConservation, DIRECTIVES_PUBLIQUES,
} from './src/core/donnees.js';
import { ajouterJours, ajouterMois } from './src/core/horloge.js';

const CLE = 'testament.v1';
let etat;

// ————————————————————————————————— persistance

function nouvelEtat(maintenant = Date.now()) {
  return {
    maintenant,
    compte: creerCompte({ id: 'moi', at: maintenant, cadenceMois: 6 }),
    messages: [],
    profil: { nomAffichage: '' }, // BR-A-08 : profil minimal, pseudonyme autorisé
  };
}

function charger() {
  try {
    const brut = localStorage.getItem(CLE);
    if (!brut) return nouvelEtat();
    const lu = JSON.parse(brut);
    if (!lu || !lu.compte) return nouvelEtat();
    return lu;
  } catch {
    return nouvelEtat();
  }
}

function sauver() {
  try {
    localStorage.setItem(CLE, JSON.stringify(etat));
  } catch (err) {
    notifier('Sauvegarde impossible : ' + err.message, true);
  }
}

// ————————————————————————————————— horloge et synchronisation

const maintenant = () => etat.maintenant;
const nomAffiche = () => (etat.profil && etat.profil.nomAffichage) || 'Votre proche';

// Fait avancer le protocole puis la délivrance, et démarre l'exécution dès que
// la grâce est épuisée (BR-D-01). Appelée après chaque action et chaque saut
// de temps du banc d'essai.
function synchroniser() {
  tick(etat.compte, maintenant());
  if (etat.compte.etat === ETATS.EN_EXECUTION && !etat.compte.execution) {
    demarrerExecution(etat.compte, etat.messages, { at: maintenant() });
  }
  tickExecution(etat.compte, maintenant());
  // La vague immédiate close, le compte entre en liquidation : c'est elle qui
  // arme l'horloge des 90 jours avant la suppression de E1 (BR-E-01).
  if (etat.compte.etat === ETATS.EN_EXECUTION && etat.compte.execution) {
    const vagueClose = etat.compte.execution.plis
      .filter((p) => p.type === 'IMMEDIAT')
      .every((p) => p.etat !== ETATS_PLI.PLANIFIE);
    if (vagueClose) terminerExecution(etat.compte, { at: maintenant() });
  }
  tickPublications(etat.compte, etat.messages, maintenant()); // §5.3 — soumet, ne publie jamais
  tickDonnees(etat.compte, etat.messages, maintenant());      // §6 — conserve puis supprime
}

// ————————————————————————————————— utilitaires d'affichage

const dateFR = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const fmt = (ts) => (ts == null ? '—' : dateFR.format(new Date(ts)));
const fmtCourt = (ts) => (ts == null ? '—' : new Date(ts).toISOString().slice(0, 10));
const echap = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function joursEntre(a, b) {
  return Math.round((b - a) / 86_400_000);
}

function dans(ts) {
  if (ts == null) return '—';
  const j = joursEntre(maintenant(), ts);
  if (j < 0) return `il y a ${-j} j`;
  if (j === 0) return "aujourd'hui";
  if (j < 45) return `dans ${j} jours`;
  const mois = Math.round(j / 30.44);
  return `dans ${mois} mois`;
}

let minuteurNotif;
function notifier(texte, erreur = false) {
  const el = document.getElementById('notif');
  el.textContent = texte;
  el.classList.toggle('erreur', erreur);
  el.hidden = false;
  clearTimeout(minuteurNotif);
  minuteurNotif = setTimeout(() => { el.hidden = true; }, 5200);
}

// Enveloppe toute action : exécute, synchronise, sauve, rend, notifie.
function agir(fn, succes) {
  try {
    const r = fn();
    synchroniser();
    sauver();
    rendre();
    if (succes) notifier(typeof succes === 'function' ? succes(r) : succes);
    return r;
  } catch (err) {
    notifier(err.message, true);
    rendre();
    return null;
  }
}

// ————————————————————————————————— routage

const ROUTES = [
  ['#/', 'Tableau de bord'],
  ['#/messages', 'Messages'],
  ['#/contacts', 'Contacts de confiance'],
  ['#/plis', 'Destinataires'],
  ['#/public', 'Public'],
  ['#/donnees', 'Mes données'],
  ['#/journal', 'Journal'],
];
// Le simulateur du protocole vit à côté de l'application : lien direct, pas une route.
const LIEN_SIMULATEUR = './demo/';

function route() {
  const h = location.hash || '#/';
  const [chemin, param] = [h.split('/').slice(0, 2).join('/'), h.split('/')[2]];
  return { h, chemin, param };
}

function rendreNav() {
  const { h } = route();
  const plis = etat.compte.execution ? etat.compte.execution.plis.length : 0;
  document.getElementById('nav').innerHTML = ROUTES
    .filter(([r]) => r !== '#/plis' || plis > 0)
    .map(([r, libelle]) => {
      const actif = h === r || (r !== '#/' && h.startsWith(r)) ? ' class="actif"' : '';
      const pastille = r === '#/plis' && plis ? `<span class="pastille">${plis}</span>` : '';
      return `<a href="${r}"${actif}>${libelle}${pastille}</a>`;
    }).join('') + `<a href="${LIEN_SIMULATEUR}" class="externe">Simulateur du protocole</a>`;
  const chip = document.getElementById('chip-etat');
  chip.textContent = LIBELLE_ETAT[etat.compte.etat] || etat.compte.etat;
  chip.dataset.etat = etat.compte.etat;
}

const LIBELLE_ETAT = {
  NOUVEAU: 'compte non armé',
  ARME: 'sous protocole',
  EN_PAUSE: 'absence programmée',
  SOLLICITATION: 'check-in attendu',
  ENQUETE: 'enquête en cours',
  VEILLE_LONGUE: 'veille longue',
  PRESUME_DECEDE: 'présumé décédé',
  EN_EXECUTION: 'exécution en cours',
  EXECUTE: 'exécuté',
  EN_LIQUIDATION: 'liquidation',
  DESARME: 'protocole inactif',
  SUPPRIME: 'compte supprimé',
};

function rendre() {
  rendreNav();
  const { chemin, param } = route();
  const vue = document.getElementById('vue');
  const vues = {
    '#/': vueTableau,
    '#/messages': () => (param ? vueEditeur(param) : vueMessages()),
    '#/contacts': vueContacts,
    '#/plis': () => (param ? vueSas(param) : vuePlis()),
    '#/public': vuePublic,
    '#/donnees': vueDonnees,
    '#/journal': vueJournal,
  };
  try {
    vue.innerHTML = (vues[chemin] || vueTableau)();
  } catch (err) {
    // Un écran qui échoue ne doit jamais laisser croire qu'on est ailleurs.
    vue.innerHTML = `<h1>Cet écran n’a pas pu s’afficher</h1>
      <p class="sous">${echap(err.message)}</p>
      <div class="actions"><a class="bouton" href="#/">Retour au tableau de bord</a></div>`;
  }
  document.getElementById('banc-date').textContent = 'date simulée : ' + fmtCourt(maintenant());
  window.scrollTo({ top: 0 });
}

// ————————————————————————————————— projection : date théorique d'exécution
// BR-C-11 : « date théorique d'exécution si rien ne change ». Projection
// d'affichage — la vérité reste la machine à états.

function dateTheoriqueExecution() {
  const c = etat.compte;
  if (c.presomption) return c.presomption.graceFinAt;
  if (![ETATS.ARME, ETATS.SOLLICITATION, ETATS.ENQUETE, ETATS.VEILLE_LONGUE, ETATS.EN_PAUSE].includes(c.etat)) return null;
  const base = c.derniereS1 || c.creeLe;
  const decision = ajouterJours(ajouterMois(base, c.regles.cadenceMois), 86);
  // Sans deux contacts acceptants, aucun quorum possible : le plancher de
  // 18 mois sans signal S1 domine (BR-C-05).
  const plancher = ajouterMois(base, 18);
  const depart = contactsAcceptants(c).length >= 2 ? decision : Math.max(decision, plancher);
  return ajouterJours(depart, 90); // grâce non réductible (BR-C-06)
}

// ————————————————————————————————— vue : tableau de bord (BR-C-11)

function vueTableau() {
  const c = etat.compte;
  if (c.etat === ETATS.NOUVEAU || c.etat === ETATS.DESARME) return vueArmement();

  const e = prochainesEcheances(c);
  // Un message purgé par le cycle de vie n'a plus de version : on ne l'affiche pas.
  const scelles = etat.messages.filter((m) => m.versions.length > 0);
  const prochaine = e.echeanceCadence;
  const execution = dateTheoriqueExecution();
  const urgent = [ETATS.SOLLICITATION, ETATS.ENQUETE, ETATS.PRESUME_DECEDE].includes(c.etat);

  const alerte = urgent ? `
    <div class="alerte rouge">
      <b>${c.etat === ETATS.PRESUME_DECEDE
        ? 'Vos messages seront délivrés le ' + fmt(c.presomption.graceFinAt) + '.'
        : 'Nous cherchons à vous joindre.'}</b>
      <p>${c.etat === ETATS.PRESUME_DECEDE
        ? 'Vous êtes présumé décédé. Un seul clic annule tout le processus et le compteur repart de zéro (BR-C-03).'
        : 'Sans signe de vie de votre part, l’enquête auprès de vos contacts de confiance se poursuivra.'}</p>
      <div class="actions"><button class="principal" data-action="checkin">Je suis là</button></div>
    </div>` : '';

  const lignes = scelles.length ? scelles.map((m) => {
    const v = m.versions[m.versions.length - 1];
    const quand = v.delivrance.mode === 'DATE_FIXE'
      ? 'le ' + fmt(v.delivrance.dateFixe)
      : 'à l’exécution';
    return `<div class="item">
      <div class="item-tete"><span class="titre">${echap(m.titre)}</span>
        <span class="etiq ok">scellé</span>
        ${v.fortImpact ? '<span class="etiq warn">fort impact</span>' : ''}</div>
      <div class="item-meta">→ ${v.destinataires.map((d) => echap(d.prenomNom)).join(', ')} · ${quand}
        · dernière modification ${fmt(v.scelleLe)}</div>
    </div>`;
  }).join('') : '<p class="vide">Aucun message scellé : rien ne partira. Les brouillons ne sont jamais délivrés (BR-B-03).</p>';

  return `
  <h1>Tableau de bord</h1>
  <p class="sous">Ce que le service sait de vous, et ce qui arriverait si vous ne reveniez plus.</p>
  ${alerte}

  <div class="statut">
    <div><span class="l">Dernière preuve de vie</span><span class="v">${fmt(c.derniereS1)}</span>
      <span class="p">${dans(c.derniereS1)}</span></div>
    <div><span class="l">Prochaine sollicitation</span><span class="v">${fmt(prochaine)}</span>
      <span class="p">cadence : tous les ${c.regles.cadenceMois} mois</span></div>
    <div><span class="l">Exécution si rien ne change</span><span class="v ${urgent ? 'crit' : ''}">${fmt(execution)}</span>
      <span class="p">${dans(execution)}</span></div>
    <div><span class="l">Contacts acceptants</span><span class="v ${contactsAcceptants(c).length >= 2 ? 'ok' : 'crit'}">${contactsAcceptants(c).length}</span>
      <span class="p">${contactsAcceptants(c).length >= 2 ? 'quorum possible' : 'quorum impossible : délai porté à 21 mois'}</span></div>
  </div>

  ${contactsAcceptants(c).length < 2 ? `<div class="alerte">
    <b>Avec deux contacts de confiance, vos messages partiraient environ 9 mois après votre décès ; sans, il faut attendre 21 mois.</b>
    <p>Un contact n’a jamais accès à vos messages (BR-A-12) et ne peut rien déclencher seul (BR-A-14).</p>
    <div class="actions"><a class="bouton" href="#/contacts">Désigner un contact</a></div>
  </div>` : ''}

  <div class="carte">
    <p class="carte-titre">Ce qui partira — ligne de temps (BR-B-21)</p>
    <div class="liste">${lignes}</div>
    <div class="actions"><a class="bouton" href="#/messages">Gérer mes messages</a></div>
  </div>

  <div class="carte">
    <p class="carte-titre">Garder la main</p>
    <div class="actions">
      <button class="principal" data-action="checkin">Je suis là</button>
      <button data-action="pause">Absence programmée…</button>
      <button data-action="cadence">Changer la cadence…</button>
    </div>
    <p class="item-meta" style="margin-top:.8rem">Dans le produit réel, une connexion authentifiée vaut preuve de vie (S1).
    Ici, le check-in est explicite pour qu’on puisse observer le protocole.</p>
  </div>`;
}

function vueArmement() {
  const scelles = etat.messages.filter((m) => m.etat === ETATS_MESSAGE.SCELLE).length;
  const pret = scelles >= 1;
  const vierge = etat.messages.length === 0;
  const decouverte = vierge ? `
  <div class="alerte">
    <b>Première visite ? Tout explorer en trente secondes.</b>
    <p>Charge un compte d’exemple : deux messages scellés, deux contacts de confiance,
    une lettre publique programmée. Vous pourrez ensuite faire défiler le temps depuis
    le banc d’essai, en bas de l’écran, et voir le protocole se dérouler.</p>
    <div class="actions">
      <button class="principal" data-action="exemple-rapide">Charger l’exemple et explorer</button>
      <a class="bouton" href="#/messages">Plutôt écrire mon propre message</a>
    </div>
  </div>` : '';

  return `
  <h1>Armer votre compte</h1>
  <p class="sous">Tant que le compte n’est pas armé, aucun protocole ne court et rien ne peut être délivré (BR-C-01).</p>
  ${decouverte}

  <div class="alerte">
    <b>Ceci n’est pas un testament au sens juridique.</b>
    <p>Aucune disposition patrimoniale, aucun legs, aucune valeur successorale : le service transmet des mots,
    pas un héritage. Il ne constate pas votre décès, il le présume, au terme d’un protocole que vous choisissez (BR-J-02).</p>
  </div>

  <div class="carte">
    <p class="carte-titre">Conditions d’armement</p>
    <div class="liste">
      <div class="item"><div class="item-tete"><span class="etiq ${pret ? 'ok' : 'crit'}">${pret ? 'fait' : 'à faire'}</span>
        <span class="titre">Au moins un message scellé</span></div>
        <div class="item-meta">${scelles} message(s) scellé(s). <a href="#/messages">Rédiger un message</a></div></div>
      <div class="item"><div class="item-tete"><span class="etiq ok">simulé</span>
        <span class="titre">Authentification à deux facteurs active</span></div>
        <div class="item-meta">Obligatoire à l’armement, pas à l’inscription, pour ne pas casser la conversion (BR-A-02, R-A-3).</div></div>
      <div class="item"><div class="item-tete"><span class="etiq ok">simulé</span>
        <span class="titre">Deux canaux de contact vérifiés</span></div>
        <div class="item-meta">Le protocole repose sur la redondance : un canal unique le rend inopérant (BR-A-03).</div></div>
    </div>
  </div>

  <div class="carte">
    <p class="carte-titre">Profil (BR-A-08)</p>
    <label><span class="l">Nom d’affichage — pseudonyme autorisé</span>
      <input type="text" id="nom-affichage" value="${echap((etat.profil && etat.profil.nomAffichage) || '')}" placeholder="Camille R.">
      <span class="aide">C’est ce nom que vos destinataires verront. Aucun annuaire, aucune recherche entre utilisateurs (BR-A-09).</span></label>
  </div>

  <div class="carte">
    <p class="carte-titre">Cadence de check-in (4.2)</p>
    <label><span class="l">À quelle fréquence acceptez-vous d’être sollicité ?</span>
      <select id="cadence-armement">
        ${CADENCES_MOIS.map((m) => `<option value="${m}"${m === 6 ? ' selected' : ''}>tous les ${m} mois${m === 6 ? ' (recommandé)' : ''}</option>`).join('')}
      </select>
      <span class="aide">Plus la cadence est courte, plus la délivrance est rapide après un décès réel — et plus vous êtes sollicité de votre vivant.</span>
    </label>
    <div class="case"><input type="checkbox" id="accuse">
      <span>J’ai lu et compris le protocole : sollicitations, enquête auprès de mes contacts, présomption de décès,
      puis 90 jours de grâce avant délivrance (BR-C-02).</span></div>
    <div class="actions">
      <button class="principal" data-action="armer"${pret ? '' : ' disabled'}>Armer le compte</button>
    </div>
  </div>`;
}

// ————————————————————————————————— vue : messages (module B)

function vueMessages() {
  const items = etat.messages.map((m) => {
    const v = m.versions[m.versions.length - 1];
    const supprime = m.etat === ETATS_MESSAGE.SUPPRIME;
    const scelle = Boolean(v);
    const dest = (v ? v.destinataires : m.travail.destinataires).map((d) => echap(d.prenomNom)).filter(Boolean);
    return `<div class="item">
      <div class="item-tete">
        <span class="titre">${echap(m.titre)}</span>
        <span class="etiq ${supprime ? 'crit' : scelle ? 'ok' : 'froid'}">${supprime ? 'supprimé' : scelle ? 'scellé' : 'brouillon'}</span>
        ${m.travail.fortImpact ? '<span class="etiq warn">fort impact</span>' : ''}
        ${scelle && m.versions.length > 1 ? `<span class="etiq">version ${m.versions.length}</span>` : ''}
      </div>
      <div class="item-meta">${dest.length ? '→ ' + dest.join(', ') : 'aucun destinataire'}
        · ${(m.travail.texte || '').length} caractères
        ${scelle ? '· scellé le ' + fmt(v.scelleLe) : ''}</div>
      <div class="actions">
        <a class="bouton" href="#/messages/${m.id}">${scelle ? 'Relire et modifier' : 'Continuer'}</a>
        <button class="danger" data-action="supprimer-message" data-id="${m.id}">Supprimer</button>
      </div>
    </div>`;
  }).join('');

  return `
  <h1>Mes messages</h1>
  <p class="sous">Un brouillon n’est jamais délivré, quel que soit l’état du compte (BR-B-03).
  Un message scellé reste modifiable de votre vivant : seule la dernière version scellée partira (BR-B-05).</p>
  <div class="actions" style="margin-bottom:1rem">
    <button class="principal" data-action="nouveau-message">Écrire un message</button>
  </div>
  <div class="liste">${items || '<p class="vide">Aucun message pour l’instant.</p>'}</div>`;
}

function vueEditeur(id) {
  const m = etat.messages.find((x) => x.id === id);
  if (!m) return '<h1>Message introuvable</h1><p><a href="#/messages">Retour aux messages</a></p>';
  const t = m.travail;
  const scelle = m.etat === ETATS_MESSAGE.SCELLE;
  const v = m.versions[m.versions.length - 1];

  const dests = t.destinataires.map((d, i) => `<div class="item">
      <div class="item-tete"><span class="titre">${echap(d.prenomNom)}</span>
        <span class="item-meta">${echap(d.email)}${d.relation ? ' · ' + echap(d.relation) : ''}</span>
        ${d.mineur ? '<span class="etiq warn">mineur</span>' : ''}</div>
      <div class="actions"><button data-action="retirer-destinataire" data-id="${m.id}" data-index="${i}">Retirer</button></div>
    </div>`).join('');

  return `
  <h1>${echap(m.titre)}</h1>
  <p class="sous">${scelle
    ? `Scellé le ${fmt(v.scelleLe)} — exécutable à partir du ${fmt(v.executableAt)} (BR-B-09). Toute modification demandera un nouveau scellement.`
    : 'Brouillon — il ne partira pas tant qu’il n’est pas scellé.'}</p>

  <div class="carte">
    <p class="carte-titre">Le message</p>
    <label><span class="l">Titre interne (vous seul le voyez, BR-B-02)</span>
      <input type="text" id="ed-titre" value="${echap(m.titre)}"></label>
    <label><span class="l">Contenu</span>
      <textarea id="ed-texte" placeholder="Ce que vous n’avez pas pu dire…">${echap(t.texte)}</textarea>
      <span class="aide">${(t.texte || '').length} / 50 000 caractères (BR-B-06)</span></label>
    <label><span class="l">Note d’introduction — 200 caractères (BR-B-07)</span>
      <input type="text" id="ed-note" maxlength="200" value="${echap(t.note)}"
        placeholder="Affichée au destinataire avant qu’il n’ouvre le message">
      <span class="aide">C’est le seul texte que le destinataire verra avant d’ouvrir. Le contenu, lui, n’apparaît jamais dans une notification (BR-D-08).</span></label>
    <div class="case"><input type="checkbox" id="ed-impact"${t.fortImpact ? ' checked' : ''}>
      <span>Ce message est difficile à recevoir (révélation, aveu, reproche).
      Le destinataire aura un sas renforcé et 24 h de réflexion avant de pouvoir l’ouvrir (BR-B-08, BR-D-13).</span></div>
  </div>

  <div class="carte">
    <p class="carte-titre">Destinataires (BR-B-10)</p>
    <div class="liste">${dests || '<p class="vide">Aucun destinataire : le message ne peut pas être scellé.</p>'}</div>
    <div class="duo" style="margin-top:1rem">
      <label><span class="l">Prénom et nom</span><input type="text" id="ed-dest-nom" placeholder="Nour B."></label>
      <label><span class="l">Adresse email</span><input type="email" id="ed-dest-mail" placeholder="nour@exemple.org"></label>
      <label><span class="l">Lien avec vous</span><input type="text" id="ed-dest-rel" placeholder="ma fille"></label>
      <label><span class="l">&nbsp;</span><button data-action="ajouter-destinataire" data-id="${m.id}">Ajouter ce destinataire</button></label>
    </div>
    <p class="item-meta">Le destinataire n’est jamais averti de son vivant du testateur (BR-B-11).</p>
    <div class="actions"><button data-action="ajouter-groupe" data-id="${m.id}">Ajouter un groupe…</button></div>
    <p class="item-meta">Un groupe est une liste nommée : chacun reçoit son propre accès, jamais en copie
    visible des autres (BR-B-15).${groupesDe(m).length ? ' Groupes : ' + groupesDe(m).map((g) => echap(g.nom) + ' (' + g.membres + ')').join(', ') + '.' : ''}</p>
  </div>

  <div class="carte">
    <p class="carte-titre">Visibilité (BR-B-16, BR-B-17)</p>
    <div class="case"><input type="checkbox" id="ed-public"${t.visibilite === 'PUBLIC' ? ' checked' : ''}>
      <span><b>Rendre ce message public</b> — il sera lisible par tout le monde sur la plateforme,
      après relecture par un modérateur humain. Sans cette case, le message reste strictement privé.</span></div>
    <div class="case"><input type="checkbox" id="ed-public-confirme"${t.visibilite === 'PUBLIC' ? ' checked' : ''}>
      <span>Je confirme : une fois publié, ce texte pourra être lu, cité et copié par n’importe qui,
      et je ne pourrai plus contrôler ce qu’il en advient.</span></div>
    <div class="duo">
      <label><span class="l">Signature publique (BR-D-18)</span>
        <select id="ed-attribution">
          ${['NOM_COMPLET', 'PRENOM', 'PSEUDONYME', 'ANONYME'].map((a) => {
            const libelle = { NOM_COMPLET: 'mon nom complet', PRENOM: 'mon prénom seul', PSEUDONYME: 'un pseudonyme', ANONYME: 'anonyme' }[a];
            const choisi = t.autorisationPublique && t.autorisationPublique.attribution === a;
            return `<option value="${a}"${choisi ? ' selected' : ''}>${libelle}</option>`;
          }).join('')}
        </select></label>
      <label><span class="l">Publication</span>
        <select id="ed-pub-mode">
          <option value="A_EXECUTION"${t.publication.mode === 'A_EXECUTION' ? ' selected' : ''}>après ma disparition</option>
          <option value="DATE_FIXE"${t.publication.mode === 'DATE_FIXE' ? ' selected' : ''}>à une date que je choisis</option>
        </select></label>
    </div>
    <label><span class="l">Date de publication — peut tomber de votre vivant (BR-B-18)</span>
      <input type="date" id="ed-pub-date" value="${t.publication.dateFixe ? new Date(t.publication.dateFixe).toISOString().slice(0, 10) : ''}">
      <span class="aide">Rien n’est jamais mis en ligne automatiquement : à cette date, le message part en
      relecture humaine, et un modérateur décide (BR-D-15). Objectif : sept jours.</span></label>
    <div class="case"><input type="checkbox" id="ed-indexable"${t.autorisationPublique && t.autorisationPublique.indexable ? ' checked' : ''}>
      <span>Autoriser les moteurs de recherche à indexer ce message. Case volontairement distincte
      de l’autorisation de publication (BR-D-19).</span></div>
    <label><span class="l">Après la suppression de mon compte, ces mots seront… (BR-E-03)</span>
      <select id="ed-directive">
        ${DIRECTIVES_PUBLIQUES.map((d) => {
          const libelle = {
            RETRAIT_AVEC_COMPTE: 'retirés en même temps que mon compte (défaut)',
            ARCHIVE_ATTRIBUEE: 'archivés, signés de mon nom',
            ARCHIVE_ANONYMISEE: 'archivés, mais anonymisés',
          }[d];
          return `<option value="${d}"${t.directivePublique === d ? ' selected' : ''}>${libelle}</option>`;
        }).join('')}
      </select>
      <span class="aide">Un texte qui vous identifie de lui-même (« moi, maire de… ») ne peut pas
      être anonymisé : l’archive anonyme le refusera plutôt que de faire semblant (BR-E-04).</span></label>
  </div>

  <div class="carte">
    <p class="carte-titre">Quand ce message part-il ? (BR-B-18)</p>
    <label><span class="l">Délivrance</span>
      <select id="ed-mode">
        <option value="IMMEDIATE"${t.delivrance.mode === 'IMMEDIATE' ? ' selected' : ''}>dès l’exécution</option>
        <option value="DATE_FIXE"${t.delivrance.mode === 'DATE_FIXE' ? ' selected' : ''}>à une date précise</option>
      </select></label>
    <label><span class="l">Date (si date précise, horizon 25 ans — BR-B-19)</span>
      <input type="date" id="ed-date" value="${t.delivrance.dateFixe ? new Date(t.delivrance.dateFixe).toISOString().slice(0, 10) : ''}"></label>
  </div>

  <div class="actions">
    <button class="principal" data-action="sceller" data-id="${m.id}">${scelle ? 'Enregistrer et re-sceller' : 'Sceller ce message'}</button>
    <button data-action="enregistrer" data-id="${m.id}">Enregistrer le brouillon</button>
    <a class="bouton" href="#/messages">Retour</a>
  </div>`;
}

// ————————————————————————————————— vue : contacts de confiance (module A)

function vueContacts() {
  const c = etat.compte;
  const acceptants = c.contacts.filter((ct) => ct.statut === 'ACCEPTANT');
  const items = c.contacts.map((ct) => {
    const etiq = { EN_ATTENTE: ['froid', 'invitation envoyée'], ACCEPTANT: ['ok', 'acceptant'], RENONCE: ['crit', 'a renoncé'] }[ct.statut];
    return `<div class="item">
      <div class="item-tete"><span class="titre">${echap(ct.nom)}</span>
        <span class="etiq ${etiq[0]}">${etiq[1]}</span>
        <span class="item-meta">${echap(ct.email)}</span></div>
      <div class="actions">
        ${ct.statut === 'EN_ATTENTE' ? `<button data-action="accepter-contact" data-id="${ct.id}">Simuler l’acceptation</button>
          <button data-action="refuser-contact" data-id="${ct.id}">Simuler le refus</button>` : ''}
        ${ct.statut === 'ACCEPTANT' ? `<button class="danger" data-action="renoncer-contact" data-id="${ct.id}">Simuler la renonciation</button>` : ''}
      </div>
    </div>`;
  }).join('');

  return `
  <h1>Contacts de confiance</h1>
  <p class="sous">Des personnes capables d’attester de votre décès. Elles n’ont accès à rien :
  ni vos messages, ni vos destinataires, ni même leur nombre (BR-A-12). Et aucune ne peut rien
  déclencher seule — il en faut deux (BR-A-14).</p>

  <div class="carte">
    <p class="carte-titre">Vos contacts (5 au maximum — BR-A-15)</p>
    <div class="liste">${items || '<p class="vide">Aucun contact désigné. Sans contact, vos messages partiront au plus tôt 21 mois après votre dernière visite, contre environ 9 avec deux.</p>'}</div>
    <div class="duo" style="margin-top:1rem">
      <label><span class="l">Prénom et nom</span><input type="text" id="ct-nom" placeholder="Awa D."></label>
      <label><span class="l">Adresse email</span><input type="email" id="ct-mail" placeholder="awa@exemple.org"></label>
    </div>
    <div class="actions"><button class="principal" data-action="inviter-contact">Inviter ce contact</button></div>
    <p class="item-meta" style="margin-top:.8rem">Tant qu’une personne n’a pas accepté explicitement, elle ne compte pas dans le quorum (BR-A-11).
    Ici l’acceptation est simulée d’un clic ; dans le produit réel, elle passe par un lien vérifié.</p>
  </div>

  <div class="carte">
    <p class="carte-titre">Exécuteur numérique (§2.4)</p>
    <p>Un de vos contacts peut recevoir des pouvoirs de supervision — un par un, aucun par défaut.
    Il ne pourra <b>jamais</b> lire un message, en créer un, en modifier un, ni ajouter un destinataire
    (BR-A-20). Il surveille la mécanique, il n’accède pas au fond.</p>
    ${acceptants.length ? `
    <label><span class="l">Qui</span>
      <select id="ex-contact">
        ${acceptants.map((ct) => `<option value="${ct.id}"${c.executeur && c.executeur.contactId === ct.id ? ' selected' : ''}>${echap(ct.nom)}</option>`).join('')}
      </select></label>
    ${POUVOIRS.map((pouvoir) => {
      const libelle = {
        REPORT: 'Reporter l’exécution de 1 à 12 mois',
        SUSPENSION: 'Suspendre définitivement un message avant sa délivrance — seul pouvoir destructeur, à n’accorder qu’en connaissance de cause (BR-A-22)',
        COORDONNEES: 'Fournir les coordonnées manquantes d’un destinataire',
        JOURNAL: 'Recevoir le journal d’exécution',
      }[pouvoir];
      const actif = c.executeur && c.executeur.pouvoirs[pouvoir];
      return `<div class="case"><input type="checkbox" id="ex-${pouvoir}"${actif ? ' checked' : ''}>
        <span>${libelle}</span></div>`;
    }).join('')}
    <div class="actions">
      <button class="principal" data-action="designer-executeur">${c.executeur ? 'Mettre à jour les pouvoirs' : 'Désigner cet exécuteur'}</button>
      ${c.executeur ? '<button class="danger" data-action="retirer-executeur">Retirer ce rôle</button>' : ''}
    </div>` : '<p class="vide">Désignez d’abord un contact de confiance acceptant.</p>'}
  </div>`;
}

// ————————————————————————————————— vue : plis destinataires (module D)

const LIBELLE_PLI = {
  PLANIFIE: ['froid', 'en attente d’envoi'], NOTIFIE: ['warn', 'notifié'],
  SAS_OUVERT: ['warn', 'sas ouvert'], LU: ['ok', 'lu'], REFUSE: ['crit', 'refusé'],
  NON_DELIVRE: ['crit', 'non délivré'], EXPIRE: ['crit', 'lien expiré'], EFFACE: ['crit', 'effacé'],
  SUSPENDU: ['crit', 'suspendu par l’exécuteur'],
};

function vuePlis() {
  const ex = etat.compte.execution;
  if (!ex) return '<h1>Aucune délivrance en cours</h1><p>Cette page apparaît lorsque l’exécution a démarré.</p>';
  const executeur = etat.compte.executeur;
  const pouvoir = (nom) => Boolean(executeur && executeur.pouvoirs[nom]);
  const fenetre = fenetreDeReport(etat.compte);
  const apercu = pouvoir('JOURNAL') ? apercuPourExecuteur(etat.compte) : null;
  const bandeauExecuteur = executeur ? `<div class="alerte">
      <b>Exécuteur numérique : ${echap((etat.compte.contacts.find((ct) => ct.id === executeur.contactId) || {}).nom || executeur.contactId)}</b>
      <p>Pouvoirs accordés : ${POUVOIRS.filter((x) => executeur.pouvoirs[x]).map((x) => x.toLowerCase()).join(', ') || 'aucun'}.
      Il ne peut ni lire, ni modifier, ni ajouter un destinataire (BR-A-20).
      ${apercu ? ' État vu par lui : ' + Object.entries(apercu.parEtat).map(([k, v]) => v + ' ' + (LIBELLE_PLI[k] ? LIBELLE_PLI[k][1] : k)).join(', ') + '.' : ''}</p>
      ${fenetre && !ex.reportePar && maintenant() < fenetre.jusquau ? `<div class="actions">
        <button data-action="reporter-execution">Reporter l’exécution…</button>
      </div><p class="item-meta">Prévenu le ${fmt(fenetre.prevenuLe)}, il peut reporter jusqu’au ${fmt(fenetre.jusquau)} (BR-D-05).</p>` : ''}
      ${ex.reportePar ? `<p class="item-meta">Exécution reportée de ${ex.reportePar.mois} mois le ${fmt(ex.reportePar.at)}.</p>` : ''}
    </div>` : '';
  const items = ex.plis.map((p) => {
    const [cls, lib] = LIBELLE_PLI[p.etat];
    const ouvrable = [ETATS_PLI.NOTIFIE, ETATS_PLI.SAS_OUVERT, ETATS_PLI.LU].includes(p.etat);
    return `<div class="item">
      <div class="item-tete"><span class="titre">${echap(p.destinataire.prenomNom || 'destinataire effacé')}</span>
        <span class="etiq ${cls}">${lib}</span>
        <span class="item-meta">${p.messages.length} message(s) · ${p.type === 'DIFFERE' ? 'délivrance différée' : 'vague immédiate'}
        · ${p.notifieLe ? 'notifié le ' + fmt(p.notifieLe) : 'envoi prévu le ' + fmt(p.prevuLe)}</span></div>
      <div class="actions">
        ${ouvrable ? `<a class="bouton" href="#/plis/${p.id}">Ouvrir comme destinataire</a>` : ''}
        ${[ETATS_PLI.NOTIFIE, ETATS_PLI.SAS_OUVERT].includes(p.etat)
          ? `<button data-action="rebond" data-id="${p.id}">Simuler un rebond permanent</button>` : ''}
        ${pouvoir('SUSPENSION') && p.etat === ETATS_PLI.PLANIFIE
          ? (p.suspensionDemandee
            ? `<button class="danger" data-action="confirmer-suspension" data-id="${p.id}">Confirmer la suspension${maintenant() < p.suspensionDemandee.confirmableAt ? ' (dans ' + Math.ceil((p.suspensionDemandee.confirmableAt - maintenant()) / 3600000) + ' h)' : ''}</button>`
            : `<button data-action="suspendre-pli" data-id="${p.id}">Suspendre (exécuteur)</button>`) : ''}
        ${pouvoir('COORDONNEES') && [ETATS_PLI.NON_DELIVRE, ETATS_PLI.EXPIRE].includes(p.etat)
          ? `<button data-action="fournir-coordonnees" data-id="${p.id}">Corriger l’adresse (exécuteur)</button>` : ''}
      </div>
    </div>`;
  }).join('');

  return `
  <h1>Délivrance en cours</h1>
  <p class="sous">Un pli par destinataire, regroupant tous ses messages : personne ne reçoit deux
  notifications pour le même défunt (BR-D-03). Les contacts de confiance ont été prévenus le
  ${fmt(ex.demarreeLe)}, sept jours avant les destinataires, pour qu’un humain puisse annoncer
  la nouvelle avant l’automate (A-7).</p>
  ${bandeauExecuteur}
  <div class="liste">${items}</div>`;
}

// ————————————————————————————————— vue : le sas destinataire (§5.2)

function vueSas(pliId) {
  const ex = etat.compte.execution;
  const pli = ex && ex.plis.find((p) => p.id === pliId);
  if (!pli) return '<h1>Lien invalide</h1>';

  if (pli.etat === ETATS_PLI.LU) {
    const contenu = lire(etat.compte, { pliId, at: maintenant() });
    return `<div class="sas"><div class="lecture">
      ${contenu.map((m) => `<div class="corps">${echap(m.texte)}</div>`).join('<hr>')}
      <p class="signature">Message laissé par ${echap(nomAffiche())}, dernière modification le
      ${fmt(pli.messages[0].derniereModif)}. Vous pouvez le conserver : téléchargez-le, il ne
      restera en ligne que douze mois.</p>
      <div class="actions">
        <button data-action="telecharger" data-id="${pli.id}">Télécharger</button>
        <a class="bouton" href="#/plis">Retour</a>
      </div>
    </div></div>`;
  }

  let sas;
  try {
    sas = ouvrirSas(etat.compte, { pliId, at: maintenant() });
    sauver();
  } catch (err) {
    return `<div class="sas"><div class="enveloppe"><h1>Ce lien n’est plus valide</h1>
      <p>${echap(err.message)}</p><div class="actions"><a class="bouton" href="#/plis">Retour</a></div></div></div>`;
  }
  const attente = maintenant() < pli.reflexionFinAt;
  const codeAttendu = pli.code && !pli.code.utilise;

  return `<div class="sas"><div class="enveloppe">
    <p class="carte-titre">Un message vous est destiné</p>
    <h1>${echap(nomAffiche())} vous a laissé ${sas.messages.length > 1 ? sas.messages.length + ' messages' : 'un message'}</h1>
    <p>Nous sommes désolés de vous l’apprendre ainsi si vous ne le saviez pas. Rien ne presse :
    ce message vous attendra. Vous pouvez l’ouvrir aujourd’hui, dans un mois, ou jamais.</p>
    ${sas.messages.map((m) => `<div class="note">« ${echap(m.note || 'Aucune note d’introduction.')} »</div>
      <p class="item-meta">Écrit le ${fmt(m.dateMessage)}, modifié pour la dernière fois le ${fmt(m.derniereModif)}
      · ${m.nature.texte ? 'texte' : ''}${m.nature.images ? ' · ' + m.nature.images + ' image(s)' : ''}</p>`).join('')}
    ${sas.fortImpact ? `<div class="alerte rouge" style="text-align:left">
      <b>Ce message est difficile à recevoir.</b>
      <p>Son auteur l’a signalé lui-même. ${attente
        ? 'Un délai de réflexion de 24 h vous est laissé : vous pourrez l’ouvrir à partir du ' + fmt(pli.reflexionFinAt) + '.'
        : 'Prenez le temps qu’il vous faut ; des ressources d’accompagnement au deuil sont disponibles.'}</p>
    </div>` : ''}
    ${codeAttendu ? `<div class="alerte"><b>Code de vérification envoyé</b>
      <p>Pour cette démonstration, le code est affiché : <b>${pli.code.valeur}</b></p>
      <label><span class="l">Code reçu</span><input type="text" id="sas-code" placeholder="6 chiffres"></label>
      <div class="actions"><button class="principal" data-action="verifier-code" data-id="${pli.id}">Vérifier et ouvrir</button></div>
    </div>` : `<div class="choix">
      <button class="principal" data-action="demander-code" data-id="${pli.id}"${attente ? ' disabled' : ''}>Ouvrir maintenant</button>
      <button data-action="plus-tard" data-id="${pli.id}">Plus tard — me le rappeler dans 3 mois</button>
      <button data-action="refuser-pli" data-id="${pli.id}">Je ne souhaite pas le recevoir</button>
    </div>`}
  </div></div>`;
}

// ————————————————————————————————— vue : public (§5.3)

const LIBELLE_ATTRIBUTION = {
  NOM_COMPLET: 'signé du nom complet', PRENOM: 'signé du prénom',
  PSEUDONYME: 'signé d’un pseudonyme', ANONYME: 'anonyme',
};

function vuePublic() {
  const c = etat.compte;
  const profil = { nomAffichage: nomAffiche() };
  const enLigne = publicationsEnLigne(c).map((p) => {
    const v = vuePublique(p, profil);
    return `<div class="item">
      <div class="item-tete"><span class="titre">${v.anonyme ? 'Publié anonymement' : echap(v.auteur)}</span>
        <span class="etiq ok">en ligne</span>
        ${v.duVivant ? '<span class="etiq froid">publié du vivant</span>' : ''}
        ${v.indexable ? '<span class="etiq warn">indexable</span>' : ''}</div>
      <div class="item-meta">publié le ${fmt(v.publieeLe)} · ${LIBELLE_ATTRIBUTION[p.attribution]}</div>
      <p style="white-space:pre-wrap;margin:.4rem 0 0">${echap(v.texte)}</p>
      <div class="actions">
        <button data-action="retirer-publication" data-id="${p.messageId}">Retirer de la publication</button>
        <button data-action="demander-retrait" data-id="${p.messageId}">Demande de retrait d’un tiers mentionné</button>
        <button data-action="basculer-reflexions" data-id="${p.messageId}">${p.reflexionsDesactivees ? 'Rouvrir les réflexions' : 'Fermer les réflexions'}</button>
      </div>
      <div class="reflexions">
        <p class="carte-titre" style="margin:.9rem 0 .5rem">Réflexions ${p.reflexionsDesactivees ? '— fermées par l’auteur (BR-D-23)' : ''}</p>
        ${reflexionsPubliques(c, p.messageId).map((r) => `<blockquote class="reflexion">
            <p>${echap(r.texte)}</p>
            <footer>${echap(r.auteur || 'un lecteur')} · ${fmt(r.publieeLe)}
              <button class="lien" data-action="signaler-reflexion" data-id="${p.messageId}">signaler</button></footer>
          </blockquote>`).join('') || '<p class="vide">Aucune réflexion publiée.</p>'}
        ${p.reflexionsDesactivees ? '' : `<div class="actions">
          <button data-action="deposer-reflexion" data-id="${p.messageId}">Déposer une réflexion</button>
        </div>`}
      </div>
    </div>`;
  }).join('');

  const file = fileModeration(c).map((p) => `<div class="item">
      <div class="item-tete"><span class="titre">${echap(p.titreInterne)}</span>
        <span class="etiq warn">en relecture</span>
        ${p.duVivant ? '<span class="etiq froid">auteur vivant</span>' : ''}</div>
      <div class="item-meta">soumis le ${fmt(p.soumiseLe)} · décision attendue avant le ${fmt(p.decisionAvant)}
        · ${LIBELLE_ATTRIBUTION[p.attribution]}${p.indexable ? ' · indexation demandée' : ''}</div>
      <p style="white-space:pre-wrap;margin:.4rem 0 0">${echap(p.texte)}</p>
      <div class="actions">
        <button class="principal" data-action="moderer-accepte" data-id="${p.messageId}">Publier</button>
        <button class="danger" data-action="moderer-refuse" data-id="${p.messageId}">Refuser…</button>
        ${p.duVivant ? `<button data-action="moderer-detresse" data-id="${p.messageId}">Signaler une détresse</button>` : ''}
      </div>
    </div>`).join('');

  const programmes = etat.messages.filter((m) => {
    const v = m.versions[m.versions.length - 1];
    return v && v.visibilite === 'PUBLIC'
      && !(c.publications || []).some((p) => p.messageId === m.id && p.version === v.numero);
  }).map((m) => {
    const v = m.versions[m.versions.length - 1];
    const due = dateDuePublication(c, m);
    return `<div class="item">
      <div class="item-tete"><span class="titre">${echap(m.titre)}</span>
        <span class="etiq froid">programmé</span></div>
      <div class="item-meta">${v.publication.mode === 'DATE_FIXE'
        ? 'publication demandée pour le ' + fmt(due) + ' — ' + dans(due)
        : 'publication après votre disparition'} · ${LIBELLE_ATTRIBUTION[v.autorisationPublique.attribution]}</div>
      <div class="actions"><a class="bouton" href="#/messages/${m.id}">Modifier</a></div>
    </div>`;
  }).join('');

  return `
  <h1>Messages publics</h1>
  <p class="sous">Un message public peut être programmé pour une date que vous choisissez —
  <b>y compris de votre vivant</b> (BR-B-18). Mais rien n’est jamais mis en ligne automatiquement :
  à l’échéance, le texte part en relecture humaine, et un modérateur décide (BR-D-15).</p>

  <div class="carte">
    <p class="carte-titre">En ligne</p>
    <div class="liste">${enLigne || '<p class="vide">Rien n’est publié pour l’instant.</p>'}</div>
  </div>

  <div class="carte">
    <p class="carte-titre">Programmé, pas encore soumis</p>
    <div class="liste">${programmes || '<p class="vide">Aucun message public programmé.</p>'}</div>
  </div>

  <div class="carte">
    <p class="carte-titre">Console de modération — rôle du service, pas le vôtre</p>
    <p class="item-meta">Cette file n’existerait pas dans l’application réelle du testateur : elle est
    montrée ici pour rendre la règle observable. Toute décision est nominative et motivée (BR-M-03),
    et un refus ne supprime rien en silence : le message bascule en privé vers vos contacts de
    confiance, avec le motif (BR-D-17).</p>
    <div class="liste">${file || '<p class="vide">File vide.</p>'}</div>

    <p class="carte-titre" style="margin-top:1.4rem">Réflexions en attente (BR-D-21)</p>
    <div class="liste">${fileModerationReflexions(c).map((r) => `<div class="item">
        <div class="item-tete"><span class="titre">${echap(r.auteur.pseudo || r.auteur.id)}</span>
          <span class="etiq warn">en relecture</span>
          <span class="item-meta">déposée le ${fmt(r.deposeeLe)}</span></div>
        <p style="margin:.3rem 0 0">${echap(r.texte)}</p>
        <div class="actions">
          <button class="principal" data-action="reflexion-accepte" data-id="${r.id}">Publier</button>
          <button class="danger" data-action="reflexion-rejette" data-id="${r.id}">Rejeter…</button>
        </div>
      </div>`).join('') || '<p class="vide">Aucune réflexion en attente.</p>'}</div>

    <p class="carte-titre" style="margin-top:1.4rem">Signalements — les graves en 24 h (BR-D-25)</p>
    <div class="liste">${fileSignalements(c).map((sig) => `<div class="item">
        <div class="item-tete"><span class="titre">${sig.categorie.toLowerCase().replace('_', ' ')}</span>
          <span class="etiq ${sig.grave ? 'crit' : 'warn'}">${sig.grave ? 'grave' : 'ordinaire'}</span>
          <span class="item-meta">${sig.cible === 'REFLEXION' ? 'réflexion' : 'message public'} · à traiter avant le ${fmt(sig.traiterAvant)}</span></div>
        <div class="actions">
          <button class="danger" data-action="signalement-retirer" data-id="${sig.id}" data-index="${sig.cible}">Retirer le contenu…</button>
          <button data-action="signalement-classer" data-id="${sig.id}" data-index="${sig.cible}">Classer sans suite</button>
        </div>
      </div>`).join('') || '<p class="vide">Aucun signalement.</p>'}</div>
  </div>`;
}

// ————————————————————————————————— vue : mes données (module E, §6)

const LIBELLE_DIRECTIVE = {
  RETRAIT_AVEC_COMPTE: 'retirées en même temps que mon compte',
  ARCHIVE_ATTRIBUEE: 'archivées, signées de mon nom',
  ARCHIVE_ANONYMISEE: 'archivées, mais anonymisées',
};

function vueDonnees() {
  const c = etat.compte;
  const vue = etatConservation(c, maintenant());
  const suppression = c.suppressionDemandee;

  const differes = vue.e2.length ? vue.e2.map((e) => `<div class="item">
      <div class="item-tete"><span class="titre">${echap(e.message)}</span>
        <span class="etiq froid">en attente</span></div>
      <div class="item-meta">délivrance le ${fmt(e.dateFixe)} · conservé jusqu’au ${fmt(e.conservationFinAt)}</div>
    </div>`).join('') : '<p class="vide">Aucun message différé en réserve.</p>';

  const archives = vue.e3.length ? vue.e3.map((e) => `<div class="item">
      <div class="item-tete"><span class="titre">${echap(e.message)}</span>
        <span class="etiq ${e.attribution === 'ANONYME' ? 'froid' : 'ok'}">${e.attribution === 'ANONYME' ? 'anonymisé' : 'attribué'}</span></div>
    </div>`).join('') : '<p class="vide">Aucune archive publique.</p>';

  return `
  <h1>Mes données</h1>
  <p class="sous">Ce que le service garde, ce qu’il détruit, et quand. Quatre ensembles
  au sort différent : votre compte, les messages encore à venir, ce qui a été publié,
  et le journal des décisions.</p>

  ${suppression ? `<div class="alerte rouge">
    <b>Suppression de votre compte demandée.</b>
    <p>Elle deviendra définitive le ${fmt(suppression.effectiveAt)}. D’ici là, vous pouvez
    encore revenir en arrière — ce délai de 72 heures existe pour vous protéger d’une
    prise de contrôle de votre boîte mail (BR-A-06).</p>
    <div class="actions"><button class="principal" data-action="annuler-suppression">Annuler la suppression</button></div>
  </div>` : ''}

  <div class="statut">
    <div><span class="l">E1 · compte et messages privés</span>
      <span class="v ${vue.e1.statut === 'SUPPRIME' ? 'crit' : 'ok'}">${vue.e1.statut === 'SUPPRIME' ? 'supprimé' : 'présent'}</span>
      <span class="p">${vue.e1.statut === 'SUPPRIME'
        ? 'le ' + fmt(vue.e1.le) + ' · sauvegardes purgées avant le ' + fmt(vue.e1.sauvegardesPurgeesAvant)
        : vue.e1.suppressionLe ? 'suppression prévue le ' + fmt(vue.e1.suppressionLe) : '90 jours après l’exécution'}</span></div>
    <div><span class="l">E2 · messages différés</span><span class="v">${vue.e2.length}</span>
      <span class="p">conservés hors du compte, jusqu’à leur date</span></div>
    <div><span class="l">E3 · publications</span><span class="v">${vue.e3.length}</span>
      <span class="p">archivées selon vos directives</span></div>
    <div><span class="l">E4 · journal</span><span class="v">${vue.e4.entrees}</span>
      <span class="p">faits et dates seulement, conservés 5 ans</span></div>
  </div>

  <div class="carte">
    <p class="carte-titre">E2 — ce qui survivra à mon compte (BR-B-20)</p>
    <div class="liste">${differes}</div>
    <p class="item-meta" style="margin-top:.7rem">Un message programmé à une date lointaine
    est conservé dans un magasin séparé, réduit au strict nécessaire : le texte, le
    destinataire, la date. Un incident sur le reste du compte ne peut pas l’emporter.</p>
  </div>

  <div class="carte">
    <p class="carte-titre">E3 — mes messages publics après moi</p>
    <div class="liste">${archives}</div>
    <p class="item-meta" style="margin-top:.7rem">Le sort de chaque message public se choisit
    de votre vivant, dans l’éditeur du message. Aucun réglage ne verse par défaut à l’archive
    (BR-E-03), et un texte qui reste identifiant par lui-même ne peut pas être faussement
    anonymisé (BR-E-04).</p>
  </div>

  <div class="carte">
    <p class="carte-titre">Emporter mes données (BR-E-07)</p>
    <p>Un dossier ouvert, lisible sans ce service : vos messages en texte et en HTML,
    et un index JSON de tout le reste.</p>
    <div class="actions"><button data-action="exporter">Télécharger mes données</button></div>
  </div>

  <div class="carte">
    <p class="carte-titre">Supprimer mon compte (BR-E-06)</p>
    <p>Immédiat, sauf un délai de rétractation de 72 heures. Tous les messages non
    délivrés sont détruits — définitivement.</p>
    <div class="actions">
      <button class="danger" data-action="supprimer-compte"${suppression ? ' disabled' : ''}>Demander la suppression</button>
    </div>
  </div>`;
}

// ————————————————————————————————— vue : journal (PD-7)

function vueJournal() {
  const lignes = [...etat.compte.journal].reverse().map((ev) => `<li>
    <span class="q">${fmtCourt(ev.at)}</span><span class="t">${ev.type}</span>
    <span class="d">${echap(JSON.stringify(ev.donnees))}</span></li>`).join('');
  return `<h1>Journal</h1>
  <p class="sous">Chaque décision, automatique ou humaine, laisse une trace horodatée et chaînée :
  c’est la seule défense possible en cas de contentieux (PD-7, BR-C-10).</p>
  <div class="carte"><ul class="journal">${lignes}</ul></div>`;
}

// ————————————————————————————————— actions

const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
const coche = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
const message = (id) => etat.messages.find((m) => m.id === id);

// Recopie le formulaire de l'éditeur dans le brouillon (module B).
function enregistrerBrouillon(id) {
  const m = message(id);
  const titre = val('ed-titre');
  if (titre) m.titre = titre;
  definirTexte(m, document.getElementById('ed-texte').value);
  definirNote(m, val('ed-note'));
  marquerFortImpact(m, coche('ed-impact'));
  if (val('ed-mode') === 'DATE_FIXE' && val('ed-date')) {
    programmerDateFixe(m, Date.parse(val('ed-date') + 'T09:00:00Z'), maintenant());
  } else {
    revenirImmediate(m);
  }
  // Publication publique : consentement en deux temps, jamais pré-coché (BR-B-16).
  if (document.getElementById('ed-public') && coche('ed-public')) {
    if (!coche('ed-public-confirme')) {
      throw new Error('Cochez aussi la confirmation : une publication publique est irréversible dans les faits (BR-B-16).');
    }
    demanderPublication(m, maintenant());
    confirmerPublication(m, {
      at: maintenant(), attribution: val('ed-attribution') || 'PRENOM', indexable: coche('ed-indexable'),
    });
    if (val('ed-pub-mode') === 'DATE_FIXE' && val('ed-pub-date')) {
      programmerPublication(m, { mode: 'DATE_FIXE', dateTs: Date.parse(val('ed-pub-date') + 'T09:00:00Z'), at: maintenant() });
    } else {
      programmerPublication(m, { mode: 'A_EXECUTION', at: maintenant() });
    }
    if (val('ed-directive')) definirDirectivePublique(m, val('ed-directive'));
  } else if (m.travail.visibilite === 'PUBLIC') {
    revoquerPublication(m);
  }
}

const ACTIONS = {
  // — testateur
  checkin: () => agir(() => signalS1(etat.compte, { type: 'CONNEXION', at: maintenant() }),
    'Preuve de vie enregistrée : le compteur repart de zéro et tout processus en cours est annulé.'),
  pause: () => {
    const mois = Number(prompt('Absence programmée de combien de mois ? (1 à 12)', '3'));
    if (!mois) return;
    agir(() => demarrerPause(etat.compte, { jusquau: ajouterMois(maintenant(), mois), at: maintenant(), auth: { deuxFacteurs: true } }),
      `Absence programmée de ${mois} mois : le protocole est suspendu, rien ne peut se déclencher.`);
  },
  cadence: () => {
    const mois = Number(prompt('Cadence de check-in : 1, 3, 6 ou 12 mois ?', String(etat.compte.regles.cadenceMois)));
    if (!mois) return;
    agir(() => changerCadence(etat.compte, { cadenceMois: mois, at: maintenant(), auth: { deuxFacteurs: true } }),
      `Cadence portée à ${mois} mois.`);
  },
  armer: () => {
    if (!coche('accuse')) { notifier('Il faut confirmer avoir lu le protocole (BR-C-02).', true); return; }
    const cadence = Number(val('cadence-armement'));
    etat.profil = { nomAffichage: val('nom-affichage') || 'Votre proche' };
    agir(() => {
      changerCadence(etat.compte, { cadenceMois: cadence, at: maintenant(), auth: { deuxFacteurs: true } });
      armer(etat.compte, {
        at: maintenant(), auth: { deuxFacteurs: true },
        canauxVerifies: 2, messagesScelles: etat.messages.filter((m) => m.etat === ETATS_MESSAGE.SCELLE).length,
        accuseLecture: true,
      });
    }, 'Compte armé. Le protocole de preuve de vie court à partir de maintenant.');
  },

  // — messages
  'exemple-rapide': () => {
    jeuExemple();
    agir(() => {}, 'Compte d’exemple chargé. Faites défiler le temps depuis le banc d’essai, en bas.');
    location.hash = '#/';
  },
  'nouveau-message': () => {
    const id = 'm' + (etat.messages.length + 1) + '-' + Math.random().toString(36).slice(2, 6);
    etat.messages.push(creerMessage({ id, auteurId: etat.compte.id, titre: 'Nouveau message', at: maintenant() }));
    sauver();
    location.hash = '#/messages/' + id;
  },
  enregistrer: (id) => agir(() => enregistrerBrouillon(id), 'Brouillon enregistré. Il ne partira pas tant qu’il n’est pas scellé.'),
  sceller: (id) => agir(() => {
    enregistrerBrouillon(id);
    const v = sceller(message(id), maintenant());
    return v;
  }, (v) => `Message scellé (version ${v.numero}). Il deviendra exécutable le ${fmt(v.executableAt)} — 24 h de délai (BR-B-09).`),
  'supprimer-message': (id) => {
    if (!confirm('Supprimer définitivement ce message ?')) return;
    etat.messages = etat.messages.filter((m) => m.id !== id);
    agir(() => {}, 'Message supprimé.');
  },
  'ajouter-destinataire': (id) => agir(() => {
    enregistrerBrouillon(id); // sinon le re-rendu perdrait la saisie en cours
    ajouterDestinataire(message(id), {
      prenomNom: val('ed-dest-nom') || 'Sans nom',
      email: val('ed-dest-mail'),
      relation: val('ed-dest-rel') || null,
    });
  }, 'Destinataire ajouté. Il n’en sera jamais averti de votre vivant (BR-B-11).'),
  'ajouter-groupe': (id) => {
    const nom = prompt('Nom du groupe :', 'La famille');
    if (!nom) return;
    const liste = prompt('Adresses, séparées par des virgules :', 'nour@exemple.org, sami@exemple.org');
    if (!liste) return;
    agir(() => {
      enregistrerBrouillon(id);
      ajouterGroupe(message(id), {
        nom,
        membres: liste.split(',').map((mail) => {
          const email = mail.trim();
          return { prenomNom: email.split('@')[0], email };
        }),
      });
    }, 'Groupe ajouté. La délivrance restera individuelle (BR-B-15).');
  },
  'retirer-destinataire': (id, index) => agir(() => {
    enregistrerBrouillon(id);
    message(id).travail.destinataires.splice(Number(index), 1);
  }, 'Destinataire retiré.'),

  // — contacts de confiance
  'inviter-contact': () => agir(() => {
    inviterContact(etat.compte, {
      id: 'c' + Math.random().toString(36).slice(2, 7),
      nom: val('ct-nom') || 'Sans nom', email: val('ct-mail'), at: maintenant(),
    });
  }, 'Invitation envoyée. Le contact doit l’accepter explicitement pour compter (BR-A-11).'),
  'accepter-contact': (id) => agir(() => accepterInvitation(etat.compte, { id, at: maintenant() }), 'Contact acceptant.'),
  'refuser-contact': (id) => agir(() => refuserInvitation(etat.compte, { id, at: maintenant() }),
    'Refus enregistré : les données de ce tiers sont purgées immédiatement.'),
  'renoncer-contact': (id) => agir(() => renoncerContact(etat.compte, { id, at: maintenant() }),
    'Renonciation enregistrée : vous en êtes informé sans délai (BR-A-13).'),
};

// — parcours destinataire (§5.2)
Object.assign(ACTIONS, {
  'demander-code': (id) => agir(() => {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    envoyerCode(etat.compte, { pliId: id, code, at: maintenant() });
  }, 'Un code à usage unique vient d’être envoyé — aucune création de compte n’est demandée (BR-D-10).'),
  'verifier-code': (id) => agir(() => {
    verifierCode(etat.compte, { pliId: id, code: val('sas-code'), at: maintenant() });
    lire(etat.compte, { pliId: id, at: maintenant() });
  }, 'Message ouvert. Votre lecture est enregistrée, mais communiquée à personne (BR-D-12).'),
  'plus-tard': (id) => agir(() => differer(etat.compte, { pliId: id, mois: 3, at: maintenant() }),
    'Rappel dans trois mois. Aucune relance ne vous sera envoyée entre-temps.'),
  'refuser-pli': (id) => {
    if (!confirm('Refuser définitivement ce message ?')) return;
    agir(() => refuser(etat.compte, { pliId: id, at: maintenant() }),
      'Refus enregistré. Le message est conservé douze mois au cas où vous changeriez d’avis (BR-D-11).');
    location.hash = '#/plis';
  },
  telecharger: (id) => {
    const archive = telecharger(etat.compte, { pliId: id, at: maintenant() });
    const texte = archive.messages.map((m) => m.texte).join('\n\n———\n\n');
    const url = URL.createObjectURL(new Blob([texte], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'message-testament.txt'; a.click();
    URL.revokeObjectURL(url);
    sauver();
    notifier('Message téléchargé : il vous appartient désormais, hors du service.');
  },
  rebond: (id) => agir(() => signalerRebond(etat.compte, { pliId: id, at: maintenant() }),
    'Rebond permanent simulé : 3 nouvelles tentatives sur 30 jours, puis bascule sur le destinataire de secours (BR-D-07).'),
});

// — exécuteur numérique (§2.4)
Object.assign(ACTIONS, {
  'designer-executeur': () => {
    const pouvoirs = {};
    for (const pouvoir of POUVOIRS) pouvoirs[pouvoir] = coche('ex-' + pouvoir);
    if (pouvoirs.SUSPENSION && !confirm(
      'Le pouvoir de suspension est irréversible : votre exécuteur pourra détruire un message '
      + 'avant qu’il ne parte, par exemple celui destiné à quelqu’un qu’il n’aime pas. L’accorder ?')) {
      return;
    }
    agir(() => designerExecuteur(etat.compte, { contactId: val('ex-contact'), pouvoirs, at: maintenant() }),
      'Exécuteur désigné. Chaque pouvoir a été accordé explicitement — aucun ne l’est par défaut (BR-A-18).');
  },
  'retirer-executeur': () => agir(() => retirerExecuteur(etat.compte, { at: maintenant() }),
    'Rôle retiré. Les pouvoirs disparaissent avec lui.'),
  'reporter-execution': () => {
    const mois = Number(prompt('Reporter l’exécution de combien de mois ? (1 à 12)', '3'));
    if (!mois) return;
    agir(() => reporterExecution(etat.compte, { mois, at: maintenant() }),
      `Exécution reportée de ${mois} mois. Les autres contacts en sont informés (BR-A-21).`);
  },
  'suspendre-pli': (id) => agir(() => demanderSuspension(etat.compte, { pliId: id, at: maintenant() }),
    'Suspension demandée. Elle exige une confirmation 48 heures plus tard, et sera irréversible (BR-A-22).'),
  'confirmer-suspension': (id) => {
    if (!confirm('Confirmer la suspension ? Le message sera détruit et ne partira jamais.')) return;
    agir(() => confirmerSuspension(etat.compte, { pliId: id, at: maintenant() }),
      'Message suspendu définitivement.');
  },
  'fournir-coordonnees': (id) => {
    const email = prompt('Nouvelle adresse pour ce destinataire :', 'nouvelle@exemple.org');
    if (!email) return;
    agir(() => fournirCoordonnees(etat.compte, { pliId: id, email, at: maintenant() }),
      'Canal réparé : le destinataire ne change pas, seule son adresse est corrigée (BR-A-19 c).');
  },
});

// — réflexions publiques et signalements (§5.3)
Object.assign(ACTIONS, {
  'deposer-reflexion': (id) => {
    const texte = prompt('Votre réflexion — elle passera par une relecture humaine avant d’être visible :', '');
    if (!texte) return;
    agir(() => deposerReflexion(etat.compte, {
      messageId: id,
      // Le dépôt anonyme est impossible (BR-D-22) : ici, un compte vérifié est simulé.
      auteur: { id: 'lecteur-demo', pseudo: 'Un lecteur', compteVerifie: true },
      texte, at: maintenant(),
    }), 'Réflexion déposée. Elle ne paraîtra qu’après relecture humaine (BR-D-21).');
  },
  'reflexion-accepte': (id) => agir(
    () => modererReflexion(etat.compte, { reflexionId: id, decision: 'ACCEPTE', moderateur: 'moderateur-demo', at: maintenant() }),
    'Réflexion publiée.'),
  'reflexion-rejette': (id) => {
    const motif = prompt('Motif du rejet (obligatoire) :', 'propos déplacés');
    if (!motif) return;
    agir(() => modererReflexion(etat.compte, { reflexionId: id, decision: 'REJETE', motif, moderateur: 'moderateur-demo', at: maintenant() }),
      'Réflexion rejetée, avec motif.');
  },
  'basculer-reflexions': (id) => {
    const p = (etat.compte.publications || []).find((x) => x.messageId === id);
    agir(() => definirReflexions(etat.compte, { messageId: id, actives: Boolean(p && p.reflexionsDesactivees) }),
      'Réglage des réflexions modifié. Après l’exécution, il deviendra définitif (BR-D-23).');
  },
  'signaler-reflexion': (id) => {
    const reflexions = (etat.compte.reflexions || []).filter((r) => r.messageId === id && r.etat === 'PUBLIEE');
    if (!reflexions.length) return;
    const categorie = prompt('Catégorie : HAINE, HARCELEMENT, CONTENU_ILLICITE, ATTEINTE_VIE_PRIVEE, AUTRE', 'HAINE');
    if (!categorie) return;
    agir(() => signalerContenu(etat.compte, {
      cible: 'REFLEXION', id: reflexions[reflexions.length - 1].id,
      categorie, par: 'lecteur-demo', at: maintenant(),
    }), 'Signalement enregistré. Les catégories graves sont traitées en 24 heures (BR-D-25).');
  },
  'signalement-retirer': (id, cible) => {
    const motif = prompt('Motif du retrait (obligatoire) :', 'contenu manifestement illicite');
    if (!motif) return;
    agir(() => traiterSignalement(etat.compte, { cible, id, retirer: true, motif, moderateur: 'moderateur-demo', at: maintenant() }),
      'Contenu retiré, avec motif.');
  },
  'signalement-classer': (id, cible) => agir(
    () => traiterSignalement(etat.compte, { cible, id, retirer: false, moderateur: 'moderateur-demo', at: maintenant() }),
    'Signalement classé sans suite, et journalisé.'),
});

// — cycle de vie des données (§6)
Object.assign(ACTIONS, {
  exporter: () => {
    const paquet = exporter(etat.compte, etat.messages, maintenant());
    const separateur = String.fromCharCode(10) + '————— ';
    const contenu = paquet.fichiers
      .filter((f) => f.chemin.endsWith('.txt') || f.chemin.endsWith('.json'))
      .map((f) => separateur + f.chemin + ' —————' + String.fromCharCode(10) + f.contenu)
      .join(String.fromCharCode(10, 10));
    const url = URL.createObjectURL(new Blob([contenu], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'mes-donnees-testament.txt'; a.click();
    URL.revokeObjectURL(url);
    notifier(`Export de ${paquet.index.messages.length} message(s) et du journal — format ouvert (BR-E-07).`);
  },
  'supprimer-compte': () => {
    if (!confirm('Demander la suppression définitive du compte ? Vous aurez 72 heures pour revenir en arrière.')) return;
    agir(() => demanderSuppressionCompte(etat.compte, { at: maintenant(), auth: { deuxFacteurs: true } }),
      'Suppression demandée. Elle deviendra définitive dans 72 heures — avancez le temps pour la voir s’exécuter.');
  },
  'annuler-suppression': () => agir(() => annulerSuppressionCompte(etat.compte, { at: maintenant() }),
    'Suppression annulée. Rien n’a été détruit.'),
});

// — modération et publication (§5.3)
Object.assign(ACTIONS, {
  'moderer-accepte': (id) => agir(
    () => deciderModeration(etat.compte, { messageId: id, decision: 'ACCEPTE', moderateur: 'moderateur-demo', at: maintenant() }),
    'Message publié après relecture humaine. Aucune publication n’est jamais automatique (BR-D-15).'),
  'moderer-refuse': (id) => {
    const motif = prompt('Motif du refus (obligatoire, il sera communiqué) :', 'met en cause une personne vivante');
    if (!motif) return;
    agir(() => deciderModeration(etat.compte, { messageId: id, decision: 'REFUSE', motif, moderateur: 'moderateur-demo', at: maintenant() }),
      'Refus motivé. Le message n’est pas supprimé : il bascule en privé vers vos contacts de confiance (BR-D-17).');
  },
  'moderer-detresse': (id) => agir(
    () => signalerDetresse(etat.compte, { messageId: id, moderateur: 'moderateur-demo', at: maintenant() }),
    'Alerte déclenchée : des ressources d’aide sont présentées à l’auteur, qui est vivant (§7.4).'),
  'retirer-publication': (id) => {
    if (!confirm('Retirer ce message de la publication ?')) return;
    agir(() => retirerPublication(etat.compte, { messageId: id, par: 'auteur', motif: 'retrait demandé par l’auteur', at: maintenant() }),
      'Publication retirée.');
  },
  'demander-retrait': (id) => {
    const motif = prompt('Motif invoqué par la personne mentionnée :', 'atteinte à ma vie privée');
    if (!motif) return;
    agir(() => demanderRetrait(etat.compte, { messageId: id, par: 'tiers-mentionne', motif, at: maintenant() }),
      'Demande enregistrée : traitement prioritaire, objectif 72 heures (BR-D-20).');
  },
});

document.addEventListener('click', (evt) => {
  const bouton = evt.target.closest('[data-action]');
  if (!bouton) return;
  const fn = ACTIONS[bouton.dataset.action];
  if (fn) { evt.preventDefault(); fn(bouton.dataset.id, bouton.dataset.index); }
});

// ————————————————————————————————— banc d'essai

function jeuExemple() {
  etat = nouvelEtat(Date.parse('2026-01-15T10:00:00Z'));
  const m1 = creerMessage({ id: 'm1', auteurId: 'moi', titre: 'Pour Nour', at: etat.maintenant });
  definirTexte(m1, 'Nour,\n\nIl y a trois choses que je n’ai jamais su te dire de vive voix.\n\nLa première, c’est que le jour de ta naissance, j’ai eu peur — pas de toi, de moi.');
  definirNote(m1, 'Une lettre écrite un dimanche de janvier.');
  ajouterDestinataire(m1, { prenomNom: 'Nour B.', email: 'nour@exemple.org', relation: 'ma fille' });
  definirSecours(m1, { prenomNom: 'Sami B.', email: 'sami@exemple.org' });
  sceller(m1, etat.maintenant);

  const m2 = creerMessage({ id: 'm2', auteurId: 'moi', titre: 'À Sami — la lettre difficile', at: etat.maintenant });
  definirTexte(m2, 'Sami,\n\nIl y a une chose que notre famille t’a cachée pendant quarante ans.');
  definirNote(m2, 'Ce message contient une révélation de famille.');
  marquerFortImpact(m2);
  ajouterDestinataire(m2, { prenomNom: 'Sami B.', email: 'sami@exemple.org', relation: 'mon frère' });
  sceller(m2, etat.maintenant);

  const m3 = creerMessage({ id: 'm3', auteurId: 'moi', titre: 'Lettre ouverte — publication de mon vivant', at: etat.maintenant });
  const PARAGRAPHE = String.fromCharCode(10, 10); // saut de paragraphe
  definirTexte(m3, 'À qui voudra bien la lire.' + PARAGRAPHE
    + 'J’ai attendu quarante ans pour écrire ces lignes, et j’ai décidé de ne pas attendre ma mort pour qu’on les lise.');
  demanderPublication(m3, etat.maintenant);
  confirmerPublication(m3, { at: etat.maintenant, attribution: 'PRENOM', indexable: false });
  programmerPublication(m3, { mode: 'DATE_FIXE', dateTs: ajouterMois(etat.maintenant, 3), at: etat.maintenant });
  sceller(m3, etat.maintenant);

  etat.messages = [m1, m2, m3];
  etat.profil = { nomAffichage: 'Camille R.' };
  armer(etat.compte, { at: etat.maintenant, auth: { deuxFacteurs: true }, canauxVerifies: 2, messagesScelles: 3, accuseLecture: true });
  for (const [id, nom] of [['awa', 'Awa D.'], ['bilal', 'Bilal M.']]) {
    inviterContact(etat.compte, { id, nom, email: id + '@exemple.org', at: etat.maintenant });
    accepterInvitation(etat.compte, { id, at: etat.maintenant });
  }
}

const BANC = {
  s2: () => agir(() => {
    const r = signalS2(etat.compte, { type: 'OUVERTURE_EMAIL', at: maintenant() });
    if (r.effet === 'AUCUN') throw new Error('Signal faible sans effet ici — un S2 ne remet jamais le compteur à zéro (BR-C-04).');
  }, 'Email ouvert sans authentification : escalade décalée de 30 jours, compteur inchangé (BR-C-04).'),
  attester: () => {
    const libres = contactsAcceptants(etat.compte).filter(
      (c) => !etat.compte.attestations.some((a) => a.contactId === c.id && !a.invalideeAt));
    if (!libres.length) { notifier('Aucun contact acceptant disponible pour attester.', true); return; }
    agir(() => attesterDeces(etat.compte, { contactId: libres[0].id, piece: 'acte-deces.pdf', at: maintenant() }),
      `${libres[0].nom} atteste le décès. Il en faut deux pour un quorum (BR-A-14) — ou une seule avec pièce si vous n’avez qu’un contact.`);
  },
  exemple: () => {
    if (!confirm('Remplacer les données actuelles par un jeu d’exemple ?')) return;
    jeuExemple();
    agir(() => {}, 'Jeu d’exemple chargé : compte armé, deux messages scellés, deux contacts acceptants.');
  },
  raz: () => {
    if (!confirm('Effacer toutes les données locales et repartir de zéro ?')) return;
    etat = nouvelEtat();
    agir(() => {}, 'Tout a été effacé.');
    location.hash = '#/';
  },
};

document.getElementById('banc').addEventListener('click', (evt) => {
  const b = evt.target.closest('button');
  if (!b) return;
  if (b.id === 'banc-repli') {
    document.getElementById('banc').classList.toggle('replie');
    b.textContent = document.getElementById('banc').classList.contains('replie') ? 'déplier' : 'réduire';
    return;
  }
  if (b.dataset.temps) {
    etat.maintenant = ajouterJours(maintenant(), Number(b.dataset.temps));
    const avant = etat.compte.journal.length;
    synchroniser();
    sauver();
    rendre();
    const nouveaux = etat.compte.journal.slice(avant).map((e) => e.type);
    notifier(nouveaux.length
      ? `${fmtCourt(maintenant())} — ${nouveaux.slice(0, 5).join(' · ')}${nouveaux.length > 5 ? ` · … (${nouveaux.length})` : ''}`
      : `${fmtCourt(maintenant())} — rien de nouveau.`);
    return;
  }
  if (b.dataset.banc && BANC[b.dataset.banc]) BANC[b.dataset.banc]();
});

// ————————————————————————————————— démarrage

etat = charger();
synchroniser();
sauver();
window.addEventListener('hashchange', rendre);
rendre();
