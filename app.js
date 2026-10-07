// Application Testament — coquille locale au-dessus du noyau de domaine.
// Aucune règle métier ici : tout passe par paquets/protocole/. La persistance est un
// localStorage (M2 : à remplacer par une vraie API), et le temps est celui du
// « banc d'essai » pour pouvoir observer un protocole qui se joue sur des mois.
// Aucun texte en dur : toutes les chaînes passent par t() (i18n/<langue>.json).

import {
  creerCompte, armer, signalS1, signalS2, attesterDeces, demarrerPause,
  changerCadence, tick, terminerExecution, prochainesEcheances, previsionExecution, CADENCES_MOIS, ETATS,
} from './paquets/protocole/src/compte.js';
import {
  inviterContact, accepterInvitation, renoncerContact, refuserInvitation, contactsAcceptants,
} from './paquets/protocole/src/contacts.js';
import {
  creerMessage, definirTexte, definirNote, marquerFortImpact, ajouterDestinataire,
  definirSecours, programmerDateFixe, revenirImmediate, sceller, ajouterGroupe, groupesDe,
  demanderPublication, confirmerPublication, revoquerPublication, programmerPublication,
  ETATS_MESSAGE,
} from './paquets/protocole/src/message.js';
import {
  tickPublications, fileModeration, publicationsEnLigne, deciderModeration,
  signalerDetresse, demanderRetrait, retirerPublication, vuePublique, dateDuePublication,
} from './paquets/protocole/src/publication.js';
import {
  demarrerExecution, tickExecution, ouvrirSas, envoyerCode, verifierCode,
  lire, differer, refuser, telecharger, signalerRebond, ETATS_PLI,
} from './paquets/protocole/src/execution.js';
import {
  designerExecuteur, retirerExecuteur, reporterExecution, fenetreDeReport,
  demanderSuspension, confirmerSuspension, fournirCoordonnees, apercuPourExecuteur, POUVOIRS,
} from './paquets/protocole/src/executeur.js';
import {
  deposerReflexion, modererReflexion, reflexionsPubliques, fileModerationReflexions,
  definirReflexions, signalerContenu, fileSignalements, traiterSignalement,
} from './paquets/protocole/src/reflexions.js';
import {
  tickDonnees, definirDirectivePublique, demanderSuppressionCompte,
  annulerSuppressionCompte, exporter, etatConservation, DIRECTIVES_PUBLIQUES,
} from './paquets/protocole/src/donnees.js';
import { ajouterJours, ajouterMois } from './paquets/protocole/src/horloge.js';
import {
  t, definirLangue, langueInitiale, brancherSelecteur, traduireErreur,
  date as fmt, dateCourte as fmtCourt, relatif, nombre,
} from './i18n.js';

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
    notifier(t('commun.sauvegardeImpossible', { detail: err.message }), true);
  }
}

// ————————————————————————————————— horloge et synchronisation

const maintenant = () => etat.maintenant;
const nomAffiche = () => (etat.profil && etat.profil.nomAffichage) || t('commun.votreProche');

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

const echap = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
// Un nom saisi par l'utilisateur garde son propre sens d'écriture au milieu d'une phrase (« Nour B. » dans un texte arabe).
const bdi = (s) => `<bdi>${echap(s)}</bdi>`;
const dans = (ts) => relatif(ts, maintenant());
const isoJour = (ts) => new Date(ts).toISOString().slice(0, 10); // valeur des champs <input type=date>

let minuteurNotif;
function notifier(texte, erreur = false) {
  const el = document.getElementById('notif');
  el.textContent = texte;
  el.classList.toggle('erreur', erreur);
  el.setAttribute('role', erreur ? 'alert' : 'status');
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
    notifier(traduireErreur(err.message), true);
    rendre();
    return null;
  }
}

// ————————————————————————————————— routage

// Le tableau de bord garde l'adresse #/ (liens profonds existants) ; une
// première visite sans ancre arrive sur l'accueil.
const ROUTES = [
  ['#/accueil', 'nav.accueil'],
  ['#/', 'nav.tableau'],
  ['#/messages', 'nav.messages'],
  ['#/contacts', 'nav.contacts'],
  ['#/plis', 'nav.plis'],
  ['#/public', 'nav.public'],
  ['#/donnees', 'nav.donnees'],
  ['#/journal', 'nav.journal'],
];
// Le simulateur du protocole vit à côté de l'application : lien direct, pas une route.
const LIEN_SIMULATEUR = './demo/';

function route() {
  const h = location.hash.startsWith('#/') ? location.hash : '#/accueil';
  const [chemin, param] = [h.split('/').slice(0, 2).join('/'), h.split('/')[2]];
  return { h, chemin, param };
}

function rendreNav() {
  const { h } = route();
  const plis = etat.compte.execution ? etat.compte.execution.plis.length : 0;
  document.getElementById('nav').innerHTML = ROUTES
    .filter(([r]) => r !== '#/plis' || plis > 0)
    .map(([r, cle]) => {
      const actif = h === r || (r !== '#/' && h.startsWith(r + '/'));
      const pastille = r === '#/plis' && plis ? `<span class="pastille">${nombre(plis)}</span>` : '';
      return `<a href="${r}"${actif ? ' class="actif" aria-current="page"' : ''}>${t(cle)}${pastille}</a>`;
    }).join('') + `<a href="${LIEN_SIMULATEUR}" class="externe">${t('nav.simulateur')}</a>`;
  const chip = document.getElementById('chip-etat');
  chip.textContent = t('etats.' + etat.compte.etat);
  chip.dataset.etat = etat.compte.etat;
  chip.setAttribute('aria-label', t('nav.etatCompte', { etat: t('etats.' + etat.compte.etat) }));
}

function rendre({ focus = false } = {}) {
  rendreNav();
  const { chemin, param } = route();
  const vue = document.getElementById('vue');
  const vues = {
    '#/accueil': vueAccueil,
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
    vue.innerHTML = `<h1>${t('commun.ecranEchoue')}</h1>
      <p class="sous">${echap(traduireErreur(err.message))}</p>
      <div class="actions"><a class="bouton" href="#/">${t('commun.retourTableau')}</a></div>`;
  }
  document.getElementById('banc-date').textContent = t('banc.dateSimulee', { date: fmtCourt(maintenant()) });
  const titre = vue.querySelector('h1');
  document.title = titre ? `${titre.textContent} · Testament` : 'Testament';
  window.scrollTo({ top: 0 });
  // Changement d'écran : le focus suit, pour les lecteurs d'écran et le clavier.
  if (focus) vue.focus({ preventScroll: true });
}

// ————————————————————————————————— vue : accueil (introduction, menu, guide)

function vueAccueil() {
  const rubriques = [
    ['#/', 'tableau'], ['#/messages', 'messages'], ['#/contacts', 'contacts'],
    ['#/public', 'public'], ['#/donnees', 'donnees'], ['#/journal', 'journal'],
  ];
  const etapes = ['1', '2', '3', '4', '5', '6'];
  const termes = ['preuveDeVie', 'scelle', 'quorum', 'presomption', 'grace', 'pli', 'banc'];
  const neuf = etat.compte.etat === ETATS.NOUVEAU && etat.messages.length === 0;
  return `
  <section class="intro" aria-labelledby="titre-accueil">
    <p class="surtitre">${t('accueil.surtitre')}</p>
    <h1 id="titre-accueil">${t('accueil.titre')}</h1>
    <p class="accroche">${t('accueil.accroche')}</p>
    <p>${t('accueil.intro1')}</p>
    <p>${t('accueil.intro2')}</p>
    <div class="actions">
      ${neuf
        ? `<button class="principal" data-action="exemple-rapide">${t('accueil.boutonExemple')}</button>
           <a class="bouton" href="#/">${t('accueil.boutonCommencer')}</a>`
        : `<a class="bouton principal" href="#/">${t('accueil.boutonReprendre')}</a>`}
      <a class="bouton" href="#/accueil" data-action="vers-guide">${t('accueil.boutonGuide')}</a>
    </div>
  </section>

  <div class="alerte">
    <b>${t('accueil.avertissementTitre')}</b>
    <p>${t('accueil.avertissement')}</p>
  </div>

  <section aria-labelledby="titre-menu">
    <h2 id="titre-menu">${t('accueil.menuTitre')}</h2>
    <div class="rubriques">
      ${rubriques.map(([href, cle]) => `<a class="rubrique" href="${href}">
        <b>${t('nav.' + cle)}</b><span>${t('accueil.menu.' + cle)}</span></a>`).join('')}
      <a class="rubrique" href="${LIEN_SIMULATEUR}">
        <b>${t('nav.simulateur')}</b><span>${t('accueil.menu.simulateur')}</span></a>
    </div>
  </section>

  <section id="guide" aria-labelledby="titre-guide">
    <h2 id="titre-guide" tabindex="-1">${t('accueil.guideTitre')}</h2>
    <p class="sous">${t('accueil.guideIntro')}</p>
    <ol class="etapes">
      ${etapes.map((n) => `<li><b>${t('accueil.etapes.' + n + '.titre')}</b>
        <p>${t('accueil.etapes.' + n + '.texte')}</p></li>`).join('')}
    </ol>
  </section>

  <section aria-labelledby="titre-lexique">
    <h2 id="titre-lexique">${t('accueil.lexiqueTitre')}</h2>
    <dl class="lexique">
      ${termes.map((k) => `<div><dt>${t('accueil.lexique.' + k + '.terme')}</dt>
        <dd>${t('accueil.lexique.' + k + '.definition')}</dd></div>`).join('')}
    </dl>
  </section>`;
}

// ————————————————————————————————— vue : tableau de bord (BR-C-11)

function vueTableau() {
  const c = etat.compte;
  if (c.etat === ETATS.NOUVEAU || c.etat === ETATS.DESARME) return vueArmement();

  const e = prochainesEcheances(c);
  // Un message purgé par le cycle de vie n'a plus de version : on ne l'affiche pas.
  const scelles = etat.messages.filter((m) => m.versions.length > 0);
  const prochaine = e.echeanceCadence;
  // BR-C-11, AD-3 : deux dates calculées par le paquet, jamais ici.
  const { executionSiRienNeChange, executionAuPlusTot } = previsionExecution(c);
  const nbAcceptants = contactsAcceptants(c).length;
  const urgent = [ETATS.SOLLICITATION, ETATS.ENQUETE, ETATS.PRESUME_DECEDE].includes(c.etat);
  const presume = c.etat === ETATS.PRESUME_DECEDE;

  const alerte = urgent ? `
    <div class="alerte rouge" role="alert">
      <b>${presume ? t('tableau.alertePresumeTitre', { date: fmt(c.presomption.graceFinAt) }) : t('tableau.alerteJoindreTitre')}</b>
      <p>${presume ? t('tableau.alertePresume') : t('tableau.alerteJoindre')}</p>
      <div class="actions"><button class="principal" data-action="checkin">${t('tableau.jeSuisLa')}</button></div>
    </div>` : '';

  const lignes = scelles.length ? scelles.map((m) => {
    const v = m.versions[m.versions.length - 1];
    const quand = v.delivrance.mode === 'DATE_FIXE'
      ? t('tableau.leDate', { date: fmt(v.delivrance.dateFixe) })
      : t('tableau.aLExecution');
    return `<div class="item">
      <div class="item-tete"><span class="titre">${echap(m.titre)}</span>
        <span class="etiq ok">${t('etiquettes.scelle')}</span>
        ${v.fortImpact ? `<span class="etiq warn">${t('etiquettes.fortImpact')}</span>` : ''}</div>
      <div class="item-meta">${t('commun.fleche')} ${v.destinataires.map((d) => bdi(d.prenomNom)).join(t('commun.virgule'))} · ${quand}
        · ${t('tableau.derniereModif', { date: fmt(v.scelleLe) })}</div>
    </div>`;
  }).join('') : `<p class="vide">${t('tableau.aucunScelle')}</p>`;

  const quorumLibelle = nbAcceptants >= 2 ? t('tableau.quorumPossible')
    : nbAcceptants === 1 ? t('tableau.quorumPiece') : t('tableau.quorumImpossible');

  return `
  <h1>${t('tableau.titre')}</h1>
  <p class="sous">${t('tableau.sous')}</p>
  ${alerte}

  <div class="statut">
    <div><span class="l">${t('tableau.dernierePreuve')}</span><span class="v">${fmt(c.derniereS1)}</span>
      <span class="p">${dans(c.derniereS1)}</span></div>
    <div><span class="l">${t('tableau.prochaineSollicitation')}</span><span class="v">${fmt(prochaine)}</span>
      <span class="p">${t('tableau.cadence', { n: c.regles.cadenceMois })}</span></div>
    <div><span class="l">${t('tableau.siRien')}</span><span class="v ${urgent ? 'crit' : ''}">${fmt(executionSiRienNeChange)}</span>
      <span class="p">${dans(executionSiRienNeChange)}</span></div>
    <div><span class="l">${t('tableau.auPlusTot')}</span><span class="v">${executionAuPlusTot ? fmt(executionAuPlusTot) : '—'}</span>
      <span class="p">${executionAuPlusTot ? dans(executionAuPlusTot) : t('tableau.pasDeCheminCourt')}</span></div>
    <div><span class="l">${t('tableau.acceptants')}</span><span class="v ${nbAcceptants >= 2 ? 'ok' : 'crit'}">${nombre(nbAcceptants)}</span>
      <span class="p">${quorumLibelle}</span></div>
  </div>

  ${nbAcceptants < 2 ? `<div class="alerte">
    <b>${t('tableau.conseilContactsTitre')}</b>
    <p>${t('tableau.conseilContacts')}</p>
    <div class="actions"><a class="bouton" href="#/contacts">${t('tableau.designerContact')}</a></div>
  </div>` : ''}

  <div class="carte">
    <h2 class="carte-titre">${t('tableau.ligneDeTemps')}</h2>
    <div class="liste">${lignes}</div>
    <div class="actions"><a class="bouton" href="#/messages">${t('tableau.gererMessages')}</a></div>
  </div>

  <div class="carte">
    <h2 class="carte-titre">${t('tableau.garderLaMain')}</h2>
    <div class="actions">
      <button class="principal" data-action="checkin">${t('tableau.jeSuisLa')}</button>
      <button data-action="pause">${t('tableau.absence')}</button>
      <button data-action="cadence">${t('tableau.changerCadence')}</button>
    </div>
    <p class="item-meta" style="margin-top:.8rem">${t('tableau.noteCheckin')}</p>
  </div>`;
}

function vueArmement() {
  const scelles = etat.messages.filter((m) => m.etat === ETATS_MESSAGE.SCELLE).length;
  const pret = scelles >= 1;
  const vierge = etat.messages.length === 0;
  const decouverte = vierge ? `
  <div class="alerte">
    <b>${t('armement.decouverteTitre')}</b>
    <p>${t('armement.decouverte')}</p>
    <div class="actions">
      <button class="principal" data-action="exemple-rapide">${t('armement.chargerExemple')}</button>
      <a class="bouton" href="#/messages">${t('armement.plutotEcrire')}</a>
    </div>
  </div>` : '';

  return `
  <h1>${t('armement.titre')}</h1>
  <p class="sous">${t('armement.sous')}</p>
  ${decouverte}

  <div class="alerte">
    <b>${t('armement.pasJuridiqueTitre')}</b>
    <p>${t('armement.pasJuridique')}</p>
  </div>

  <div class="carte">
    <h2 class="carte-titre">${t('armement.conditions')}</h2>
    <div class="liste">
      <div class="item"><div class="item-tete"><span class="etiq ${pret ? 'ok' : 'crit'}">${pret ? t('etiquettes.fait') : t('etiquettes.aFaire')}</span>
        <span class="titre">${t('armement.condMessage')}</span></div>
        <div class="item-meta">${t('armement.nbScelles', { n: scelles })} <a href="#/messages">${t('armement.rediger')}</a></div></div>
      <div class="item"><div class="item-tete"><span class="etiq ok">${t('etiquettes.simule')}</span>
        <span class="titre">${t('armement.cond2fa')}</span></div>
        <div class="item-meta">${t('armement.cond2faAide')}</div></div>
      <div class="item"><div class="item-tete"><span class="etiq ok">${t('etiquettes.simule')}</span>
        <span class="titre">${t('armement.condCanaux')}</span></div>
        <div class="item-meta">${t('armement.condCanauxAide')}</div></div>
    </div>
  </div>

  <div class="carte">
    <h2 class="carte-titre">${t('armement.profil')}</h2>
    <label><span class="l">${t('armement.nomAffichage')}</span>
      <input type="text" id="nom-affichage" autocomplete="nickname" value="${echap((etat.profil && etat.profil.nomAffichage) || '')}" placeholder="${t('armement.nomExemple')}">
      <span class="aide">${t('armement.nomAide')}</span></label>
  </div>

  <div class="carte">
    <h2 class="carte-titre">${t('armement.cadenceTitre')}</h2>
    <label><span class="l">${t('armement.cadenceQuestion')}</span>
      <select id="cadence-armement">
        ${CADENCES_MOIS.map((m) => `<option value="${m}"${m === 6 ? ' selected' : ''}>${t('armement.cadenceOption', { n: m })}${m === 6 ? ' ' + t('armement.recommande') : ''}</option>`).join('')}
      </select>
      <span class="aide">${t('armement.cadenceAide')}</span>
    </label>
    <label class="case"><input type="checkbox" id="accuse">
      <span>${t('armement.accuse')}</span></label>
    <div class="actions">
      <button class="principal" data-action="armer"${pret ? '' : ' disabled'}>${t('armement.armer')}</button>
    </div>
  </div>`;
}

// ————————————————————————————————— vue : messages (module B)

function vueMessages() {
  const items = etat.messages.map((m) => {
    const v = m.versions[m.versions.length - 1];
    const supprime = m.etat === ETATS_MESSAGE.SUPPRIME;
    const scelle = Boolean(v);
    const dest = (v ? v.destinataires : m.travail.destinataires).filter((d) => d.prenomNom).map((d) => bdi(d.prenomNom));
    return `<div class="item">
      <div class="item-tete">
        <span class="titre">${echap(m.titre)}</span>
        <span class="etiq ${supprime ? 'crit' : scelle ? 'ok' : 'froid'}">${t(supprime ? 'etiquettes.supprime' : scelle ? 'etiquettes.scelle' : 'etiquettes.brouillon')}</span>
        ${m.travail.fortImpact ? `<span class="etiq warn">${t('etiquettes.fortImpact')}</span>` : ''}
        ${scelle && m.versions.length > 1 ? `<span class="etiq">${t('messages.version', { n: m.versions.length })}</span>` : ''}
      </div>
      <div class="item-meta">${dest.length ? t('commun.fleche') + ' ' + dest.join(t('commun.virgule')) : t('messages.aucunDestinataire')}
        · ${t('messages.caracteres', { n: (m.travail.texte || '').length })}
        ${scelle ? '· ' + t('messages.scelleLe', { date: fmt(v.scelleLe) }) : ''}</div>
      <div class="actions">
        <a class="bouton" href="#/messages/${m.id}">${t(scelle ? 'messages.relire' : 'messages.continuer')}</a>
        <button class="danger" data-action="supprimer-message" data-id="${m.id}">${t('commun.supprimer')}</button>
      </div>
    </div>`;
  }).join('');

  return `
  <h1>${t('messages.titre')}</h1>
  <p class="sous">${t('messages.sous')}</p>
  <div class="actions" style="margin-bottom:1rem">
    <button class="principal" data-action="nouveau-message">${t('messages.ecrire')}</button>
  </div>
  <div class="liste">${items || `<p class="vide">${t('messages.aucun')}</p>`}</div>`;
}

const optionsSelect = (valeurs, choisie, cle) => valeurs
  .map((v) => `<option value="${v}"${v === choisie ? ' selected' : ''}>${t(cle + '.' + v)}</option>`).join('');

function vueEditeur(id) {
  const m = etat.messages.find((x) => x.id === id);
  if (!m) return `<h1>${t('editeur.introuvable')}</h1><p><a href="#/messages">${t('editeur.retourMessages')}</a></p>`;
  const tr = m.travail;
  const scelle = m.etat === ETATS_MESSAGE.SCELLE;
  const v = m.versions[m.versions.length - 1];
  const attribution = tr.autorisationPublique && tr.autorisationPublique.attribution;

  const dests = tr.destinataires.map((d, i) => `<div class="item">
      <div class="item-tete"><span class="titre">${echap(d.prenomNom)}</span>
        <span class="item-meta">${echap(d.email)}${d.relation ? ' · ' + echap(d.relation) : ''}</span>
        ${d.mineur ? `<span class="etiq warn">${t('etiquettes.mineur')}</span>` : ''}</div>
      <div class="actions"><button data-action="retirer-destinataire" data-id="${m.id}" data-index="${i}">${t('editeur.retirer')}</button></div>
    </div>`).join('');
  const groupes = groupesDe(m);

  return `
  <h1>${echap(m.titre)}</h1>
  <p class="sous">${scelle
    ? t('editeur.sousScelle', { scelle: fmt(v.scelleLe), executable: fmt(v.executableAt) })
    : t('editeur.sousBrouillon')}</p>

  <div class="carte">
    <h2 class="carte-titre">${t('editeur.leMessage')}</h2>
    <label><span class="l">${t('editeur.titreInterne')}</span>
      <input type="text" id="ed-titre" value="${echap(m.titre)}"></label>
    <label><span class="l">${t('editeur.contenu')}</span>
      <textarea id="ed-texte" placeholder="${t('editeur.contenuExemple')}">${echap(tr.texte)}</textarea>
      <span class="aide">${t('editeur.compteur', { n: (tr.texte || '').length, max: 50000 })}</span></label>
    <label><span class="l">${t('editeur.note')}</span>
      <input type="text" id="ed-note" maxlength="200" value="${echap(tr.note)}" placeholder="${t('editeur.noteExemple')}">
      <span class="aide">${t('editeur.noteAide')}</span></label>
    <label class="case"><input type="checkbox" id="ed-impact"${tr.fortImpact ? ' checked' : ''}>
      <span>${t('editeur.fortImpact')}</span></label>
  </div>

  <div class="carte">
    <h2 class="carte-titre">${t('editeur.destinataires')}</h2>
    <div class="liste">${dests || `<p class="vide">${t('editeur.aucunDestinataire')}</p>`}</div>
    <div class="duo" style="margin-top:1rem">
      <label><span class="l">${t('commun.prenomNom')}</span><input type="text" id="ed-dest-nom" autocomplete="off" placeholder="${t('editeur.destNomExemple')}"></label>
      <label><span class="l">${t('commun.email')}</span><input type="email" id="ed-dest-mail" autocomplete="off" placeholder="nour@exemple.org"></label>
      <label><span class="l">${t('editeur.lien')}</span><input type="text" id="ed-dest-rel" placeholder="${t('editeur.lienExemple')}"></label>
      <div class="bas"><button data-action="ajouter-destinataire" data-id="${m.id}">${t('editeur.ajouterDestinataire')}</button></div>
    </div>
    <p class="item-meta">${t('editeur.jamaisAverti')}</p>
    <div class="actions"><button data-action="ajouter-groupe" data-id="${m.id}">${t('editeur.ajouterGroupe')}</button></div>
    <p class="item-meta">${t('editeur.groupeAide')}${groupes.length
      ? ' ' + t('editeur.groupes', { liste: groupes.map((g) => echap(g.nom) + ' (' + nombre(g.membres) + ')').join(t('commun.virgule')) })
      : ''}</p>
  </div>

  <div class="carte">
    <h2 class="carte-titre">${t('editeur.visibilite')}</h2>
    <label class="case"><input type="checkbox" id="ed-public"${tr.visibilite === 'PUBLIC' ? ' checked' : ''}>
      <span>${t('editeur.rendrePublic')}</span></label>
    <label class="case"><input type="checkbox" id="ed-public-confirme"${tr.visibilite === 'PUBLIC' ? ' checked' : ''}>
      <span>${t('editeur.confirmePublic')}</span></label>
    <div class="duo">
      <label><span class="l">${t('editeur.signature')}</span>
        <select id="ed-attribution">${optionsSelect(['NOM_COMPLET', 'PRENOM', 'PSEUDONYME', 'ANONYME'], attribution, 'editeur.attribution')}</select></label>
      <label><span class="l">${t('editeur.publication')}</span>
        <select id="ed-pub-mode">${optionsSelect(['A_EXECUTION', 'DATE_FIXE'], tr.publication.mode, 'editeur.publicationMode')}</select></label>
    </div>
    <label><span class="l">${t('editeur.datePublication')}</span>
      <input type="date" id="ed-pub-date" value="${tr.publication.dateFixe ? isoJour(tr.publication.dateFixe) : ''}">
      <span class="aide">${t('editeur.datePublicationAide')}</span></label>
    <label class="case"><input type="checkbox" id="ed-indexable"${tr.autorisationPublique && tr.autorisationPublique.indexable ? ' checked' : ''}>
      <span>${t('editeur.indexable')}</span></label>
    <label><span class="l">${t('editeur.directive')}</span>
      <select id="ed-directive">${optionsSelect(DIRECTIVES_PUBLIQUES, tr.directivePublique, 'editeur.directives')}</select>
      <span class="aide">${t('editeur.directiveAide')}</span></label>
  </div>

  <div class="carte">
    <h2 class="carte-titre">${t('editeur.quand')}</h2>
    <label><span class="l">${t('editeur.delivrance')}</span>
      <select id="ed-mode">${optionsSelect(['IMMEDIATE', 'DATE_FIXE'], tr.delivrance.mode, 'editeur.delivranceMode')}</select></label>
    <label><span class="l">${t('editeur.dateDelivrance')}</span>
      <input type="date" id="ed-date" value="${tr.delivrance.dateFixe ? isoJour(tr.delivrance.dateFixe) : ''}"></label>
  </div>

  <div class="actions">
    <button class="principal" data-action="sceller" data-id="${m.id}">${t(scelle ? 'editeur.resceller' : 'editeur.sceller')}</button>
    <button data-action="enregistrer" data-id="${m.id}">${t('editeur.enregistrer')}</button>
    <a class="bouton" href="#/messages">${t('commun.retour')}</a>
  </div>`;
}

// ————————————————————————————————— vue : contacts de confiance (module A)

function vueContacts() {
  const c = etat.compte;
  const acceptants = c.contacts.filter((ct) => ct.statut === 'ACCEPTANT');
  const classes = { EN_ATTENTE: 'froid', ACCEPTANT: 'ok', RENONCE: 'crit' };
  const items = c.contacts.map((ct) => `<div class="item">
      <div class="item-tete"><span class="titre">${echap(ct.nom)}</span>
        <span class="etiq ${classes[ct.statut]}">${t('contacts.statuts.' + ct.statut)}</span>
        <span class="item-meta">${echap(ct.email)}</span></div>
      <div class="actions">
        ${ct.statut === 'EN_ATTENTE' ? `<button data-action="accepter-contact" data-id="${ct.id}">${t('contacts.simulerAcceptation')}</button>
          <button data-action="refuser-contact" data-id="${ct.id}">${t('contacts.simulerRefus')}</button>` : ''}
        ${ct.statut === 'ACCEPTANT' ? `<button class="danger" data-action="renoncer-contact" data-id="${ct.id}">${t('contacts.simulerRenonciation')}</button>` : ''}
      </div>
    </div>`).join('');

  return `
  <h1>${t('contacts.titre')}</h1>
  <p class="sous">${t('contacts.sous')}</p>

  <div class="carte">
    <h2 class="carte-titre">${t('contacts.vosContacts')}</h2>
    <div class="liste">${items || `<p class="vide">${t('contacts.aucun')}</p>`}</div>
    <div class="duo" style="margin-top:1rem">
      <label><span class="l">${t('commun.prenomNom')}</span><input type="text" id="ct-nom" autocomplete="off" placeholder="${t('contacts.nomExemple')}"></label>
      <label><span class="l">${t('commun.email')}</span><input type="email" id="ct-mail" autocomplete="off" placeholder="awa@exemple.org"></label>
    </div>
    <div class="actions"><button class="principal" data-action="inviter-contact">${t('contacts.inviter')}</button></div>
    <p class="item-meta" style="margin-top:.8rem">${t('contacts.acceptationAide')}</p>
  </div>

  <div class="carte">
    <h2 class="carte-titre">${t('contacts.executeurTitre')}</h2>
    <p>${t('contacts.executeurIntro')}</p>
    ${acceptants.length ? `
    <label><span class="l">${t('contacts.qui')}</span>
      <select id="ex-contact">
        ${acceptants.map((ct) => `<option value="${ct.id}"${c.executeur && c.executeur.contactId === ct.id ? ' selected' : ''}>${echap(ct.nom)}</option>`).join('')}
      </select></label>
    ${POUVOIRS.map((pouvoir) => {
      const actif = c.executeur && c.executeur.pouvoirs[pouvoir];
      return `<label class="case"><input type="checkbox" id="ex-${pouvoir}"${actif ? ' checked' : ''}>
        <span>${t('contacts.pouvoirs.' + pouvoir)}</span></label>`;
    }).join('')}
    <div class="actions">
      <button class="principal" data-action="designer-executeur">${t(c.executeur ? 'contacts.majPouvoirs' : 'contacts.designerExecuteur')}</button>
      ${c.executeur ? `<button class="danger" data-action="retirer-executeur">${t('contacts.retirerRole')}</button>` : ''}
    </div>` : `<p class="vide">${t('contacts.dabordAcceptant')}</p>`}
  </div>`;
}

// ————————————————————————————————— vue : plis destinataires (module D)

const CLASSE_PLI = {
  PLANIFIE: 'froid', NOTIFIE: 'warn', SAS_OUVERT: 'warn', LU: 'ok', REFUSE: 'crit',
  NON_DELIVRE: 'crit', EXPIRE: 'crit', EFFACE: 'crit', SUSPENDU: 'crit',
};
const libellePli = (etatPli) => t('plis.etats.' + etatPli);

function vuePlis() {
  const ex = etat.compte.execution;
  if (!ex) return `<h1>${t('plis.aucuneTitre')}</h1><p>${t('plis.aucune')}</p>`;
  const executeur = etat.compte.executeur;
  const pouvoir = (nom) => Boolean(executeur && executeur.pouvoirs[nom]);
  const fenetre = fenetreDeReport(etat.compte);
  const apercu = pouvoir('JOURNAL') ? apercuPourExecuteur(etat.compte) : null;
  const nomExecuteur = executeur
    ? (etat.compte.contacts.find((ct) => ct.id === executeur.contactId) || {}).nom || executeur.contactId : '';
  const pouvoirsAccordes = executeur
    ? POUVOIRS.filter((x) => executeur.pouvoirs[x]).map((x) => t('plis.pouvoirsCourts.' + x)).join(t('commun.virgule')) : '';
  const bandeauExecuteur = executeur ? `<div class="alerte">
      <b>${t('plis.executeur', { nom: bdi(nomExecuteur) })}</b>
      <p>${t('plis.pouvoirsAccordes', { liste: pouvoirsAccordes || t('plis.aucunPouvoir') })}
      ${apercu ? ' ' + t('plis.etatVu', { liste: Object.entries(apercu.parEtat).map(([k, v]) => nombre(v) + ' ' + libellePli(k)).join(t('commun.virgule')) }) : ''}</p>
      ${fenetre && !ex.reportePar && maintenant() < fenetre.jusquau ? `<div class="actions">
        <button data-action="reporter-execution">${t('plis.reporter')}</button>
      </div><p class="item-meta">${t('plis.fenetreReport', { prevenu: fmt(fenetre.prevenuLe), jusquau: fmt(fenetre.jusquau) })}</p>` : ''}
      ${ex.reportePar ? `<p class="item-meta">${t('plis.reportee', { n: ex.reportePar.mois, date: fmt(ex.reportePar.at) })}</p>` : ''}
    </div>` : '';
  const items = ex.plis.map((p) => {
    const ouvrable = [ETATS_PLI.NOTIFIE, ETATS_PLI.SAS_OUVERT, ETATS_PLI.LU].includes(p.etat);
    const heures = p.suspensionDemandee ? Math.ceil((p.suspensionDemandee.confirmableAt - maintenant()) / 3600000) : 0;
    return `<div class="item">
      <div class="item-tete"><span class="titre">${echap(p.destinataire.prenomNom || t('plis.destinataireEfface'))}</span>
        <span class="etiq ${CLASSE_PLI[p.etat]}">${libellePli(p.etat)}</span>
        <span class="item-meta">${t('commun.nMessages', { n: p.messages.length })} · ${t(p.type === 'DIFFERE' ? 'plis.differe' : 'plis.vagueImmediate')}
        · ${p.notifieLe ? t('plis.notifieLe', { date: fmt(p.notifieLe) }) : t('plis.envoiPrevu', { date: fmt(p.prevuLe) })}</span></div>
      <div class="actions">
        ${ouvrable ? `<a class="bouton" href="#/plis/${p.id}">${t('plis.ouvrirDestinataire')}</a>` : ''}
        ${[ETATS_PLI.NOTIFIE, ETATS_PLI.SAS_OUVERT].includes(p.etat)
          ? `<button data-action="rebond" data-id="${p.id}">${t('plis.simulerRebond')}</button>` : ''}
        ${pouvoir('SUSPENSION') && p.etat === ETATS_PLI.PLANIFIE
          ? (p.suspensionDemandee
            ? `<button class="danger" data-action="confirmer-suspension" data-id="${p.id}">${t('plis.confirmerSuspension')}${heures > 0 ? ' ' + t('plis.dansHeures', { n: heures }) : ''}</button>`
            : `<button data-action="suspendre-pli" data-id="${p.id}">${t('plis.suspendre')}</button>`) : ''}
        ${pouvoir('COORDONNEES') && [ETATS_PLI.NON_DELIVRE, ETATS_PLI.EXPIRE].includes(p.etat)
          ? `<button data-action="fournir-coordonnees" data-id="${p.id}">${t('plis.corrigerAdresse')}</button>` : ''}
      </div>
    </div>`;
  }).join('');

  return `
  <h1>${t('plis.titre')}</h1>
  <p class="sous">${t('plis.sous', { date: fmt(ex.demarreeLe) })}</p>
  ${bandeauExecuteur}
  <div class="liste">${items}</div>`;
}

// ————————————————————————————————— vue : le sas destinataire (§5.2)

function vueSas(pliId) {
  const ex = etat.compte.execution;
  const pli = ex && ex.plis.find((p) => p.id === pliId);
  if (!pli) return `<h1>${t('sas.lienInvalide')}</h1>`;

  if (pli.etat === ETATS_PLI.LU) {
    const contenu = lire(etat.compte, { pliId, at: maintenant() });
    return `<div class="sas"><div class="lecture">
      ${contenu.map((m) => `<div class="corps" dir="auto">${echap(m.texte)}</div>`).join('<hr>')}
      <p class="signature">${t('sas.signature', { nom: bdi(nomAffiche()), date: fmt(pli.messages[0].derniereModif) })}</p>
      <div class="actions">
        <button data-action="telecharger" data-id="${pli.id}">${t('sas.telecharger')}</button>
        <a class="bouton" href="#/plis">${t('commun.retour')}</a>
      </div>
    </div></div>`;
  }

  let sas;
  try {
    sas = ouvrirSas(etat.compte, { pliId, at: maintenant() });
    sauver();
  } catch (err) {
    return `<div class="sas"><div class="enveloppe"><h1>${t('sas.plusValide')}</h1>
      <p>${echap(traduireErreur(err.message))}</p><div class="actions"><a class="bouton" href="#/plis">${t('commun.retour')}</a></div></div></div>`;
  }
  const attente = maintenant() < pli.reflexionFinAt;
  const codeAttendu = pli.code && !pli.code.utilise;

  return `<div class="sas"><div class="enveloppe">
    <p class="carte-titre">${t('sas.destine')}</p>
    <h1>${t('sas.vousALaisse', { nom: bdi(nomAffiche()), n: sas.messages.length })}</h1>
    <p>${t('sas.desoles')}</p>
    ${sas.messages.map((m) => `<div class="note" dir="auto">${t('commun.guillemets', { texte: echap(m.note || t('sas.aucuneNote')) })}</div>
      <p class="item-meta">${t('sas.ecritLe', { ecrit: fmt(m.dateMessage), modifie: fmt(m.derniereModif) })}
      · ${m.nature.texte ? t('sas.texte') : ''}${m.nature.images ? ' · ' + t('sas.images', { n: m.nature.images }) : ''}</p>`).join('')}
    ${sas.fortImpact ? `<div class="alerte rouge" style="text-align:start">
      <b>${t('sas.difficileTitre')}</b>
      <p>${t('sas.difficileAuteur')} ${attente
        ? t('sas.reflexion24h', { date: fmt(pli.reflexionFinAt) })
        : t('sas.prenezLeTemps')}</p>
    </div>` : ''}
    ${codeAttendu ? `<div class="alerte"><b>${t('sas.codeEnvoye')}</b>
      <p>${t('sas.codeDemo', { code: pli.code.valeur })}</p>
      <label><span class="l">${t('sas.codeRecu')}</span><input type="text" id="sas-code" inputmode="numeric" autocomplete="one-time-code" placeholder="${t('sas.sixChiffres')}"></label>
      <div class="actions"><button class="principal" data-action="verifier-code" data-id="${pli.id}">${t('sas.verifier')}</button></div>
    </div>` : `<div class="choix">
      <button class="principal" data-action="demander-code" data-id="${pli.id}"${attente ? ' disabled' : ''}>${t('sas.ouvrir')}</button>
      <button data-action="plus-tard" data-id="${pli.id}">${t('sas.plusTard')}</button>
      <button data-action="refuser-pli" data-id="${pli.id}">${t('sas.refuser')}</button>
    </div>`}
  </div></div>`;
}

// ————————————————————————————————— vue : public (§5.3)

const attributionLibelle = (a) => t('public.attributions.' + a);

function vuePublic() {
  const c = etat.compte;
  const profil = { nomAffichage: nomAffiche() };
  const enLigne = publicationsEnLigne(c).map((p) => {
    const v = vuePublique(p, profil);
    return `<div class="item">
      <div class="item-tete"><span class="titre">${v.anonyme ? t('public.anonyme') : echap(v.auteur)}</span>
        <span class="etiq ok">${t('etiquettes.enLigne')}</span>
        ${v.duVivant ? `<span class="etiq froid">${t('etiquettes.duVivant')}</span>` : ''}
        ${v.indexable ? `<span class="etiq warn">${t('etiquettes.indexable')}</span>` : ''}</div>
      <div class="item-meta">${t('public.publieLe', { date: fmt(v.publieeLe) })} · ${attributionLibelle(p.attribution)}</div>
      <p style="white-space:pre-wrap;margin:.4rem 0 0" dir="auto">${echap(v.texte)}</p>
      <div class="actions">
        <button data-action="retirer-publication" data-id="${p.messageId}">${t('public.retirer')}</button>
        <button data-action="demander-retrait" data-id="${p.messageId}">${t('public.demandeTiers')}</button>
        <button data-action="basculer-reflexions" data-id="${p.messageId}">${t(p.reflexionsDesactivees ? 'public.rouvrirReflexions' : 'public.fermerReflexions')}</button>
      </div>
      <div class="reflexions">
        <h3 class="carte-titre" style="margin:.9rem 0 .5rem">${t('public.reflexions')} ${p.reflexionsDesactivees ? t('public.reflexionsFermees') : ''}</h3>
        ${reflexionsPubliques(c, p.messageId).map((r) => `<blockquote class="reflexion">
            <p dir="auto">${echap(r.texte)}</p>
            <footer>${echap(r.auteur || t('public.unLecteur'))} · ${fmt(r.publieeLe)}
              <button class="lien" data-action="signaler-reflexion" data-id="${p.messageId}">${t('public.signaler')}</button></footer>
          </blockquote>`).join('') || `<p class="vide">${t('public.aucuneReflexion')}</p>`}
        ${p.reflexionsDesactivees ? '' : `<div class="actions">
          <button data-action="deposer-reflexion" data-id="${p.messageId}">${t('public.deposerReflexion')}</button>
        </div>`}
      </div>
    </div>`;
  }).join('');

  const file = fileModeration(c).map((p) => `<div class="item">
      <div class="item-tete"><span class="titre">${echap(p.titreInterne)}</span>
        <span class="etiq warn">${t('etiquettes.enRelecture')}</span>
        ${p.duVivant ? `<span class="etiq froid">${t('etiquettes.auteurVivant')}</span>` : ''}</div>
      <div class="item-meta">${t('public.soumisLe', { soumis: fmt(p.soumiseLe), avant: fmt(p.decisionAvant) })}
        · ${attributionLibelle(p.attribution)}${p.indexable ? ' · ' + t('public.indexationDemandee') : ''}</div>
      <p style="white-space:pre-wrap;margin:.4rem 0 0" dir="auto">${echap(p.texte)}</p>
      <div class="actions">
        <button class="principal" data-action="moderer-accepte" data-id="${p.messageId}">${t('public.publier')}</button>
        <button class="danger" data-action="moderer-refuse" data-id="${p.messageId}">${t('public.refuser')}</button>
        ${p.duVivant ? `<button data-action="moderer-detresse" data-id="${p.messageId}">${t('public.detresse')}</button>` : ''}
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
        <span class="etiq froid">${t('etiquettes.programme')}</span></div>
      <div class="item-meta">${v.publication.mode === 'DATE_FIXE'
        ? t('public.demandeePour', { date: fmt(due), relatif: dans(due) })
        : t('public.apresDisparition')} · ${attributionLibelle(v.autorisationPublique.attribution)}</div>
      <div class="actions"><a class="bouton" href="#/messages/${m.id}">${t('commun.modifier')}</a></div>
    </div>`;
  }).join('');

  return `
  <h1>${t('public.titre')}</h1>
  <p class="sous">${t('public.sous')}</p>

  <div class="carte">
    <h2 class="carte-titre">${t('public.enLigne')}</h2>
    <div class="liste">${enLigne || `<p class="vide">${t('public.rienPublie')}</p>`}</div>
  </div>

  <div class="carte">
    <h2 class="carte-titre">${t('public.programmeTitre')}</h2>
    <div class="liste">${programmes || `<p class="vide">${t('public.aucunProgramme')}</p>`}</div>
  </div>

  <div class="carte">
    <h2 class="carte-titre">${t('public.consoleTitre')}</h2>
    <p class="item-meta">${t('public.consoleAide')}</p>
    <div class="liste">${file || `<p class="vide">${t('public.fileVide')}</p>`}</div>

    <h3 class="carte-titre" style="margin-top:1.4rem">${t('public.reflexionsAttente')}</h3>
    <div class="liste">${fileModerationReflexions(c).map((r) => `<div class="item">
        <div class="item-tete"><span class="titre">${echap(r.auteur.pseudo || r.auteur.id)}</span>
          <span class="etiq warn">${t('etiquettes.enRelecture')}</span>
          <span class="item-meta">${t('public.deposeeLe', { date: fmt(r.deposeeLe) })}</span></div>
        <p style="margin:.3rem 0 0" dir="auto">${echap(r.texte)}</p>
        <div class="actions">
          <button class="principal" data-action="reflexion-accepte" data-id="${r.id}">${t('public.publier')}</button>
          <button class="danger" data-action="reflexion-rejette" data-id="${r.id}">${t('public.rejeter')}</button>
        </div>
      </div>`).join('') || `<p class="vide">${t('public.aucuneReflexionAttente')}</p>`}</div>

    <h3 class="carte-titre" style="margin-top:1.4rem">${t('public.signalements')}</h3>
    <div class="liste">${fileSignalements(c).map((sig) => `<div class="item">
        <div class="item-tete"><span class="titre">${t('public.categories.' + sig.categorie)}</span>
          <span class="etiq ${sig.grave ? 'crit' : 'warn'}">${t(sig.grave ? 'etiquettes.grave' : 'etiquettes.ordinaire')}</span>
          <span class="item-meta">${t(sig.cible === 'REFLEXION' ? 'public.cibleReflexion' : 'public.cibleMessage')} · ${t('public.traiterAvant', { date: fmt(sig.traiterAvant) })}</span></div>
        <div class="actions">
          <button class="danger" data-action="signalement-retirer" data-id="${sig.id}" data-index="${sig.cible}">${t('public.retirerContenu')}</button>
          <button data-action="signalement-classer" data-id="${sig.id}" data-index="${sig.cible}">${t('public.classer')}</button>
        </div>
      </div>`).join('') || `<p class="vide">${t('public.aucunSignalement')}</p>`}</div>
  </div>`;
}

// ————————————————————————————————— vue : mes données (module E, §6)

function vueDonnees() {
  const c = etat.compte;
  const vue = etatConservation(c, maintenant());
  const suppression = c.suppressionDemandee;

  const differes = vue.e2.length ? vue.e2.map((e) => `<div class="item">
      <div class="item-tete"><span class="titre">${echap(e.message)}</span>
        <span class="etiq froid">${t('etiquettes.enAttente')}</span></div>
      <div class="item-meta">${t('donnees.differe', { date: fmt(e.dateFixe), jusquau: fmt(e.conservationFinAt) })}</div>
    </div>`).join('') : `<p class="vide">${t('donnees.aucunDiffere')}</p>`;

  const archives = vue.e3.length ? vue.e3.map((e) => `<div class="item">
      <div class="item-tete"><span class="titre">${echap(e.message)}</span>
        <span class="etiq ${e.attribution === 'ANONYME' ? 'froid' : 'ok'}">${t(e.attribution === 'ANONYME' ? 'etiquettes.anonymise' : 'etiquettes.attribue')}</span></div>
    </div>`).join('') : `<p class="vide">${t('donnees.aucuneArchive')}</p>`;

  const e1Supprime = vue.e1.statut === 'SUPPRIME';
  return `
  <h1>${t('donnees.titre')}</h1>
  <p class="sous">${t('donnees.sous')}</p>

  ${suppression ? `<div class="alerte rouge" role="alert">
    <b>${t('donnees.suppressionTitre')}</b>
    <p>${t('donnees.suppression', { date: fmt(suppression.effectiveAt) })}</p>
    <div class="actions"><button class="principal" data-action="annuler-suppression">${t('donnees.annulerSuppression')}</button></div>
  </div>` : ''}

  <div class="statut">
    <div><span class="l">${t('donnees.e1')}</span>
      <span class="v ${e1Supprime ? 'crit' : 'ok'}">${t(e1Supprime ? 'etiquettes.supprime' : 'donnees.present')}</span>
      <span class="p">${e1Supprime
        ? t('donnees.e1Supprime', { date: fmt(vue.e1.le), avant: fmt(vue.e1.sauvegardesPurgeesAvant) })
        : vue.e1.suppressionLe ? t('donnees.e1Prevue', { date: fmt(vue.e1.suppressionLe) }) : t('donnees.e1Delai')}</span></div>
    <div><span class="l">${t('donnees.e2')}</span><span class="v">${nombre(vue.e2.length)}</span>
      <span class="p">${t('donnees.e2Aide')}</span></div>
    <div><span class="l">${t('donnees.e3')}</span><span class="v">${nombre(vue.e3.length)}</span>
      <span class="p">${t('donnees.e3Aide')}</span></div>
    <div><span class="l">${t('donnees.e4')}</span><span class="v">${nombre(vue.e4.entrees)}</span>
      <span class="p">${t('donnees.e4Aide')}</span></div>
  </div>

  <div class="carte">
    <h2 class="carte-titre">${t('donnees.e2Titre')}</h2>
    <div class="liste">${differes}</div>
    <p class="item-meta" style="margin-top:.7rem">${t('donnees.e2Explication')}</p>
  </div>

  <div class="carte">
    <h2 class="carte-titre">${t('donnees.e3Titre')}</h2>
    <div class="liste">${archives}</div>
    <p class="item-meta" style="margin-top:.7rem">${t('donnees.e3Explication')}</p>
  </div>

  <div class="carte">
    <h2 class="carte-titre">${t('donnees.exportTitre')}</h2>
    <p>${t('donnees.export')}</p>
    <div class="actions"><button data-action="exporter">${t('donnees.telecharger')}</button></div>
  </div>

  <div class="carte">
    <h2 class="carte-titre">${t('donnees.supprimerTitre')}</h2>
    <p>${t('donnees.supprimer')}</p>
    <div class="actions">
      <button class="danger" data-action="supprimer-compte"${suppression ? ' disabled' : ''}>${t('donnees.demanderSuppression')}</button>
    </div>
  </div>`;
}

// ————————————————————————————————— vue : journal (PD-7)

function vueJournal() {
  // Les types d'événements sont des identifiants techniques : affichés tels quels.
  const lignes = [...etat.compte.journal].reverse().map((ev) => `<li>
    <span class="q">${fmtCourt(ev.at)}</span><span class="t" dir="ltr">${ev.type}</span>
    <span class="d" dir="ltr">${echap(JSON.stringify(ev.donnees))}</span></li>`).join('');
  return `<h1>${t('journal.titre')}</h1>
  <p class="sous">${t('journal.sous')}</p>
  <div class="carte"><ul class="journal" aria-label="${t('journal.titre')}">${lignes}</ul></div>`;
}

// ————————————————————————————————— actions

const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
const coche = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
const message = (id) => etat.messages.find((m) => m.id === id);
const demander = (cle, defaut = '', vars = {}) => prompt(t(cle, vars), defaut);
const confirmer = (cle, vars = {}) => confirm(t(cle, vars));

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
    if (!coche('ed-public-confirme')) throw new Error(t('notifs.cocherConfirmation'));
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
  // — navigation interne : pas d'ancre classique, elle entrerait en conflit avec les routes #/…
  'vers-guide': () => {
    const guide = document.getElementById('guide');
    guide.scrollIntoView({ behavior: 'smooth' });
    guide.querySelector('h2').focus({ preventScroll: true });
  },
  'aller-contenu': () => document.getElementById('vue').focus(),

  // — testateur
  checkin: () => agir(() => signalS1(etat.compte, { type: 'CONNEXION', at: maintenant() }), t('notifs.checkin')),
  pause: () => {
    const mois = Number(demander('invites.pause', '3'));
    if (!mois) return;
    agir(() => demarrerPause(etat.compte, { jusquau: ajouterMois(maintenant(), mois), at: maintenant(), auth: { deuxFacteurs: true } }),
      t('notifs.pause', { n: mois }));
  },
  cadence: () => {
    const mois = Number(demander('invites.cadence', String(etat.compte.regles.cadenceMois)));
    if (!mois) return;
    agir(() => changerCadence(etat.compte, { cadenceMois: mois, at: maintenant(), auth: { deuxFacteurs: true } }),
      t('notifs.cadence', { n: mois }));
  },
  armer: () => {
    if (!coche('accuse')) { notifier(t('notifs.lireProtocole'), true); return; }
    const cadence = Number(val('cadence-armement'));
    etat.profil = { nomAffichage: val('nom-affichage') || t('commun.votreProche') };
    agir(() => {
      changerCadence(etat.compte, { cadenceMois: cadence, at: maintenant(), auth: { deuxFacteurs: true } });
      armer(etat.compte, {
        at: maintenant(), auth: { deuxFacteurs: true },
        canauxVerifies: 2, messagesScelles: etat.messages.filter((m) => m.etat === ETATS_MESSAGE.SCELLE).length,
        accuseLecture: true,
      });
    }, t('notifs.arme'));
  },

  // — messages
  'exemple-rapide': () => {
    jeuExemple();
    agir(() => {}, t('notifs.exempleRapide'));
    location.hash = '#/';
  },
  'nouveau-message': () => {
    const id = 'm' + (etat.messages.length + 1) + '-' + Math.random().toString(36).slice(2, 6);
    etat.messages.push(creerMessage({ id, auteurId: etat.compte.id, titre: t('messages.nouveau'), at: maintenant() }));
    sauver();
    location.hash = '#/messages/' + id;
  },
  enregistrer: (id) => agir(() => enregistrerBrouillon(id), t('notifs.brouillon')),
  sceller: (id) => agir(() => {
    enregistrerBrouillon(id);
    return sceller(message(id), maintenant());
  }, (v) => t('notifs.scelle', { n: v.numero, date: fmt(v.executableAt) })),
  'supprimer-message': (id) => {
    if (!confirmer('invites.supprimerMessage')) return;
    etat.messages = etat.messages.filter((m) => m.id !== id);
    agir(() => {}, t('notifs.messageSupprime'));
  },
  'ajouter-destinataire': (id) => agir(() => {
    enregistrerBrouillon(id); // sinon le re-rendu perdrait la saisie en cours
    ajouterDestinataire(message(id), {
      prenomNom: val('ed-dest-nom') || t('commun.sansNom'),
      email: val('ed-dest-mail'),
      relation: val('ed-dest-rel') || null,
    });
  }, t('notifs.destinataireAjoute')),
  'ajouter-groupe': (id) => {
    const nom = demander('invites.nomGroupe', t('invites.nomGroupeDefaut'));
    if (!nom) return;
    const liste = demander('invites.adressesGroupe', 'nour@exemple.org, sami@exemple.org');
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
    }, t('notifs.groupeAjoute'));
  },
  'retirer-destinataire': (id, index) => agir(() => {
    enregistrerBrouillon(id);
    message(id).travail.destinataires.splice(Number(index), 1);
  }, t('notifs.destinataireRetire')),

  // — contacts de confiance
  'inviter-contact': () => agir(() => {
    inviterContact(etat.compte, {
      id: 'c' + Math.random().toString(36).slice(2, 7),
      nom: val('ct-nom') || t('commun.sansNom'), email: val('ct-mail'), at: maintenant(),
    });
  }, t('notifs.invitation')),
  'accepter-contact': (id) => agir(() => accepterInvitation(etat.compte, { id, at: maintenant() }), t('notifs.contactAcceptant')),
  'refuser-contact': (id) => agir(() => refuserInvitation(etat.compte, { id, at: maintenant() }), t('notifs.contactRefus')),
  'renoncer-contact': (id) => agir(() => renoncerContact(etat.compte, { id, at: maintenant() }), t('notifs.contactRenonce')),
};

// — parcours destinataire (§5.2)
Object.assign(ACTIONS, {
  'demander-code': (id) => agir(() => {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    envoyerCode(etat.compte, { pliId: id, code, at: maintenant() });
  }, t('notifs.codeEnvoye')),
  'verifier-code': (id) => agir(() => {
    verifierCode(etat.compte, { pliId: id, code: val('sas-code'), at: maintenant() });
    lire(etat.compte, { pliId: id, at: maintenant() });
  }, t('notifs.messageOuvert')),
  'plus-tard': (id) => agir(() => differer(etat.compte, { pliId: id, mois: 3, at: maintenant() }), t('notifs.plusTard')),
  'refuser-pli': (id) => {
    if (!confirmer('invites.refuserPli')) return;
    agir(() => refuser(etat.compte, { pliId: id, at: maintenant() }), t('notifs.pliRefuse'));
    location.hash = '#/plis';
  },
  telecharger: (id) => {
    const archive = telecharger(etat.compte, { pliId: id, at: maintenant() });
    const texte = archive.messages.map((m) => m.texte).join('\n\n———\n\n');
    const url = URL.createObjectURL(new Blob([texte], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = t('fichiers.message'); a.click();
    URL.revokeObjectURL(url);
    sauver();
    notifier(t('notifs.telecharge'));
  },
  rebond: (id) => agir(() => signalerRebond(etat.compte, { pliId: id, at: maintenant() }), t('notifs.rebond')),
});

// — exécuteur numérique (§2.4)
Object.assign(ACTIONS, {
  'designer-executeur': () => {
    const pouvoirs = {};
    for (const pouvoir of POUVOIRS) pouvoirs[pouvoir] = coche('ex-' + pouvoir);
    if (pouvoirs.SUSPENSION && !confirmer('invites.pouvoirSuspension')) return;
    agir(() => designerExecuteur(etat.compte, { contactId: val('ex-contact'), pouvoirs, at: maintenant() }),
      t('notifs.executeurDesigne'));
  },
  'retirer-executeur': () => agir(() => retirerExecuteur(etat.compte, { at: maintenant() }), t('notifs.executeurRetire')),
  'reporter-execution': () => {
    const mois = Number(demander('invites.reporter', '3'));
    if (!mois) return;
    agir(() => reporterExecution(etat.compte, { mois, at: maintenant() }), t('notifs.reportee', { n: mois }));
  },
  'suspendre-pli': (id) => agir(() => demanderSuspension(etat.compte, { pliId: id, at: maintenant() }), t('notifs.suspensionDemandee')),
  'confirmer-suspension': (id) => {
    if (!confirmer('invites.confirmerSuspension')) return;
    agir(() => confirmerSuspension(etat.compte, { pliId: id, at: maintenant() }), t('notifs.suspendu'));
  },
  'fournir-coordonnees': (id) => {
    const email = demander('invites.nouvelleAdresse', 'nouvelle@exemple.org');
    if (!email) return;
    agir(() => fournirCoordonnees(etat.compte, { pliId: id, email, at: maintenant() }), t('notifs.canalRepare'));
  },
});

// — réflexions publiques et signalements (§5.3)
Object.assign(ACTIONS, {
  'deposer-reflexion': (id) => {
    const texte = demander('invites.reflexion');
    if (!texte) return;
    agir(() => deposerReflexion(etat.compte, {
      messageId: id,
      // Le dépôt anonyme est impossible (BR-D-22) : ici, un compte vérifié est simulé.
      auteur: { id: 'lecteur-demo', pseudo: t('public.unLecteur'), compteVerifie: true },
      texte, at: maintenant(),
    }), t('notifs.reflexionDeposee'));
  },
  'reflexion-accepte': (id) => agir(
    () => modererReflexion(etat.compte, { reflexionId: id, decision: 'ACCEPTE', moderateur: 'moderateur-demo', at: maintenant() }),
    t('notifs.reflexionPubliee')),
  'reflexion-rejette': (id) => {
    const motif = demander('invites.motifRejet', t('invites.motifRejetDefaut'));
    if (!motif) return;
    agir(() => modererReflexion(etat.compte, { reflexionId: id, decision: 'REJETE', motif, moderateur: 'moderateur-demo', at: maintenant() }),
      t('notifs.reflexionRejetee'));
  },
  'basculer-reflexions': (id) => {
    const p = (etat.compte.publications || []).find((x) => x.messageId === id);
    agir(() => definirReflexions(etat.compte, { messageId: id, actives: Boolean(p && p.reflexionsDesactivees) }),
      t('notifs.reflexionsReglees'));
  },
  'signaler-reflexion': (id) => {
    const reflexions = (etat.compte.reflexions || []).filter((r) => r.messageId === id && r.etat === 'PUBLIEE');
    if (!reflexions.length) return;
    // Les catégories sont des codes du protocole : saisies telles quelles.
    const categorie = demander('invites.categorie', 'HAINE');
    if (!categorie) return;
    agir(() => signalerContenu(etat.compte, {
      cible: 'REFLEXION', id: reflexions[reflexions.length - 1].id,
      categorie: categorie.trim().toUpperCase(), par: 'lecteur-demo', at: maintenant(),
    }), t('notifs.signalement'));
  },
  'signalement-retirer': (id, cible) => {
    const motif = demander('invites.motifRetrait', t('invites.motifRetraitDefaut'));
    if (!motif) return;
    agir(() => traiterSignalement(etat.compte, { cible, id, retirer: true, motif, moderateur: 'moderateur-demo', at: maintenant() }),
      t('notifs.contenuRetire'));
  },
  'signalement-classer': (id, cible) => agir(
    () => traiterSignalement(etat.compte, { cible, id, retirer: false, moderateur: 'moderateur-demo', at: maintenant() }),
    t('notifs.signalementClasse')),
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
    a.href = url; a.download = t('fichiers.donnees'); a.click();
    URL.revokeObjectURL(url);
    notifier(t('notifs.export', { n: paquet.index.messages.length }));
  },
  'supprimer-compte': () => {
    if (!confirmer('invites.supprimerCompte')) return;
    agir(() => demanderSuppressionCompte(etat.compte, { at: maintenant(), auth: { deuxFacteurs: true } }),
      t('notifs.suppressionDemandee'));
  },
  'annuler-suppression': () => agir(() => annulerSuppressionCompte(etat.compte, { at: maintenant() }), t('notifs.suppressionAnnulee')),
});

// — modération et publication (§5.3)
Object.assign(ACTIONS, {
  'moderer-accepte': (id) => agir(
    () => deciderModeration(etat.compte, { messageId: id, decision: 'ACCEPTE', moderateur: 'moderateur-demo', at: maintenant() }),
    t('notifs.publie')),
  'moderer-refuse': (id) => {
    const motif = demander('invites.motifRefus', t('invites.motifRefusDefaut'));
    if (!motif) return;
    agir(() => deciderModeration(etat.compte, { messageId: id, decision: 'REFUSE', motif, moderateur: 'moderateur-demo', at: maintenant() }),
      t('notifs.refusMotive'));
  },
  'moderer-detresse': (id) => agir(
    () => signalerDetresse(etat.compte, { messageId: id, moderateur: 'moderateur-demo', at: maintenant() }),
    t('notifs.detresse')),
  'retirer-publication': (id) => {
    if (!confirmer('invites.retirerPublication')) return;
    agir(() => retirerPublication(etat.compte, { messageId: id, par: 'auteur', motif: t('invites.retraitAuteur'), at: maintenant() }),
      t('notifs.publicationRetiree'));
  },
  'demander-retrait': (id) => {
    const motif = demander('invites.motifTiers', t('invites.motifTiersDefaut'));
    if (!motif) return;
    agir(() => demanderRetrait(etat.compte, { messageId: id, par: 'tiers-mentionne', motif, at: maintenant() }),
      t('notifs.retraitTiers'));
  },
});

document.addEventListener('click', (evt) => {
  const bouton = evt.target.closest('[data-action]');
  if (!bouton) return;
  const fn = ACTIONS[bouton.dataset.action];
  if (fn) { evt.preventDefault(); fn(bouton.dataset.id, bouton.dataset.index); }
});

// ————————————————————————————————— banc d'essai

// Le compte d'exemple parle la langue du visiteur : ses textes sont des
// contenus d'utilisateur, tirés du dictionnaire au moment du chargement.
function jeuExemple() {
  etat = nouvelEtat(Date.parse('2026-01-15T10:00:00Z'));
  const x = (cle) => t('exemple.' + cle);
  const m1 = creerMessage({ id: 'm1', auteurId: 'moi', titre: x('m1Titre'), at: etat.maintenant });
  definirTexte(m1, x('m1Texte'));
  definirNote(m1, x('m1Note'));
  ajouterDestinataire(m1, { prenomNom: 'Nour B.', email: 'nour@exemple.org', relation: x('relationFille') });
  definirSecours(m1, { prenomNom: 'Sami B.', email: 'sami@exemple.org' });
  sceller(m1, etat.maintenant);

  const m2 = creerMessage({ id: 'm2', auteurId: 'moi', titre: x('m2Titre'), at: etat.maintenant });
  definirTexte(m2, x('m2Texte'));
  definirNote(m2, x('m2Note'));
  marquerFortImpact(m2);
  ajouterDestinataire(m2, { prenomNom: 'Sami B.', email: 'sami@exemple.org', relation: x('relationFrere') });
  sceller(m2, etat.maintenant);

  const m3 = creerMessage({ id: 'm3', auteurId: 'moi', titre: x('m3Titre'), at: etat.maintenant });
  definirTexte(m3, x('m3Texte'));
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
    if (r.effet === 'AUCUN') throw new Error(t('notifs.s2SansEffet'));
  }, t('notifs.s2')),
  attester: () => {
    const libres = contactsAcceptants(etat.compte).filter(
      (c) => !etat.compte.attestations.some((a) => a.contactId === c.id && !a.invalideeAt));
    if (!libres.length) { notifier(t('notifs.aucunAttestant'), true); return; }
    agir(() => attesterDeces(etat.compte, { contactId: libres[0].id, piece: 'acte-deces.pdf', at: maintenant() }),
      t('notifs.atteste', { nom: libres[0].nom }));
  },
  exemple: () => {
    if (!confirmer('invites.remplacerExemple')) return;
    jeuExemple();
    agir(() => {}, t('notifs.exempleCharge'));
  },
  raz: () => {
    if (!confirmer('invites.toutEffacer')) return;
    etat = nouvelEtat();
    agir(() => {}, t('notifs.toutEfface'));
    location.hash = '#/accueil';
  },
};

function replierBanc(replie) {
  const banc = document.getElementById('banc');
  banc.classList.toggle('replie', replie);
  const b = document.getElementById('banc-repli');
  b.textContent = t(replie ? 'banc.deplier' : 'banc.reduire');
  b.setAttribute('aria-expanded', String(!replie));
}

document.getElementById('banc').addEventListener('click', (evt) => {
  const b = evt.target.closest('button');
  if (!b) return;
  if (b.id === 'banc-repli') {
    replierBanc(!document.getElementById('banc').classList.contains('replie'));
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
      ? `${fmtCourt(maintenant())} — ${nouveaux.slice(0, 5).join(' · ')}${nouveaux.length > 5 ? ` · … (${nombre(nouveaux.length)})` : ''}`
      : t('banc.rienDeNouveau', { date: fmtCourt(maintenant()) }));
    return;
  }
  if (b.dataset.banc && BANC[b.dataset.banc]) BANC[b.dataset.banc]();
});

// Menu replié sur petit écran.
document.getElementById('menu-bouton').addEventListener('click', (evt) => {
  const ouvert = evt.currentTarget.getAttribute('aria-expanded') === 'true';
  evt.currentTarget.setAttribute('aria-expanded', String(!ouvert));
  document.querySelector('.barre').classList.toggle('menu-ouvert', !ouvert);
});
document.getElementById('nav').addEventListener('click', (evt) => {
  if (evt.target.closest('a')) {
    document.getElementById('menu-bouton').setAttribute('aria-expanded', 'false');
    document.querySelector('.barre').classList.remove('menu-ouvert');
  }
});

// ————————————————————————————————— démarrage

await definirLangue(langueInitiale(), { memoriser: false });
brancherSelecteur(() => { replierBanc(document.getElementById('banc').classList.contains('replie')); rendre(); });
etat = charger();
synchroniser();
sauver();
// Sur un petit écran, le banc d'essai commence replié : il ne doit pas masquer le contenu.
replierBanc(window.matchMedia('(max-width: 640px)').matches);
window.addEventListener('hashchange', () => {
  if (location.hash && !location.hash.startsWith('#/')) return; // simple ancre, pas une route
  rendre({ focus: true });
});
rendre();
