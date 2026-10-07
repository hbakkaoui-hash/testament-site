// Internationalisation — français, anglais, arabe.
// Toutes les chaînes vivent dans i18n/<langue>.json ; ce module les charge,
// choisit la langue (paramètre ?lang=, puis choix mémorisé, puis langue du
// navigateur), règle lang/dir sur <html>, et formate dates et nombres selon
// la locale. Les références de protocole (BR-…, PD-…, §…) ne se traduisent
// jamais : un test le vérifie sur les trois dictionnaires.

export const LANGUES = Object.freeze(['fr', 'en', 'ar']);
const CLE_LANGUE = 'testament.langue';
// Arabe en chiffres latins : cohérent avec les références (BR-C-03) et l'usage maghrébin.
const LOCALES = { fr: 'fr-FR', en: 'en-GB', ar: 'ar-u-nu-latn' };
const POLICES_ARABES = 'https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Tajawal:wght@400;500;700&display=swap';

const dictionnaires = {};
let langue = 'fr';

// Les dictionnaires peuvent être fournis d'avance (démo autonome, sans
// serveur) ; sinon ils sont lus à côté de ce module.
async function lireDictionnaire(l) {
  if (dictionnaires[l]) return dictionnaires[l];
  const embarques = globalThis.__TESTAMENT_I18N__;
  if (embarques && embarques[l]) {
    dictionnaires[l] = embarques[l];
  } else {
    const reponse = await fetch(new URL(`./i18n/${l}.json`, import.meta.url));
    dictionnaires[l] = await reponse.json();
  }
  return dictionnaires[l];
}

function lireStockage() {
  try { return localStorage.getItem(CLE_LANGUE); } catch { return null; }
}

function ecrireStockage(l) {
  try { localStorage.setItem(CLE_LANGUE, l); } catch { /* navigation privée : sans mémoire */ }
}

// ?lang= > choix mémorisé > langues du navigateur > français.
export function langueInitiale() {
  const parametre = new URLSearchParams(location.search).get('lang');
  if (LANGUES.includes(parametre)) return parametre;
  const memorisee = lireStockage();
  if (LANGUES.includes(memorisee)) return memorisee;
  for (const l of navigator.languages || [navigator.language || '']) {
    const base = String(l).slice(0, 2).toLowerCase();
    if (LANGUES.includes(base)) return base;
  }
  return 'fr';
}

export const langueCourante = () => langue;
export const locale = () => LOCALES[langue];
export const sens = () => (langue === 'ar' ? 'rtl' : 'ltr');

export async function definirLangue(l, { memoriser = true } = {}) {
  if (!LANGUES.includes(l)) l = 'fr';
  // Une seule langue chargée : les tests garantissent que les trois
  // dictionnaires ont les mêmes clés, le repli français n'est qu'un filet.
  await lireDictionnaire(l);
  langue = l;
  if (memoriser) {
    ecrireStockage(l);
    // Un ?lang= resté dans l'adresse reprendrait la main au rechargement : on l'aligne.
    const url = new URL(location.href);
    if (url.searchParams.has('lang')) {
      url.searchParams.set('lang', l);
      history.replaceState(history.state, '', url);
    }
  }
  const html = document.documentElement;
  html.lang = l;
  html.dir = sens();
  if (l === 'ar' && !document.getElementById('polices-arabes')) {
    const lien = document.createElement('link');
    lien.id = 'polices-arabes';
    lien.rel = 'stylesheet';
    lien.href = POLICES_ARABES;
    document.head.append(lien);
  }
  traduireDocument();
}

function chercher(dico, cle) {
  return cle.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), dico);
}

const regles = {};
function formePlurielle(valeur, n) {
  if (typeof valeur !== 'object' || valeur === null || n == null) return valeur;
  regles[langue] ??= new Intl.PluralRules(locale());
  return valeur[regles[langue].select(n)] ?? valeur.other;
}

// t('tableau.titre'), t('messages.n', { n: 3 }) — {nom} est remplacé par la
// variable, les nombres sont formatés selon la locale.
export function t(cle, vars = {}) {
  let valeur = chercher(dictionnaires[langue], cle);
  if (valeur === undefined && dictionnaires.fr) valeur = chercher(dictionnaires.fr, cle);
  if (valeur === undefined) return cle;
  valeur = formePlurielle(valeur, vars.n);
  return String(valeur).replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    if (v === undefined || v === null) return '';
    return typeof v === 'number' ? nombre(v) : String(v);
  });
}

// Les messages d'erreur du moteur sont écrits en français dans le paquet
// (qui reste pur) ; on les traduit ici. Inconnu : on montre l'original.
export function traduireErreur(message) {
  const texte = String(message ?? '');
  if (langue === 'fr') return texte;
  const table = chercher(dictionnaires[langue], 'moteur') || {};
  if (table[texte]) return table[texte];
  // Un seul paramètre entre guillemets : « … »
  const m = texte.match(/«\s*([^»]+?)\s*»/);
  if (m) {
    const modele = texte.replace(m[0], '« {1} »');
    if (table[modele]) return table[modele].replace('{1}', m[1]);
  }
  return texte;
}

export function nombre(n) {
  return new Intl.NumberFormat(locale()).format(n);
}

const formatsDate = {};
export function date(ts) {
  if (ts == null) return '—';
  formatsDate[langue] ??= new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return formatsDate[langue].format(new Date(ts));
}

const formatsCourts = {};
export function dateCourte(ts) {
  if (ts == null) return '—';
  formatsCourts[langue] ??= new Intl.DateTimeFormat(locale(), { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  return formatsCourts[langue].format(new Date(ts));
}

// « dans 3 mois », "in 3 months", « بعد 3 أشهر » — calculé, pas traduit à la main.
const relatifs = {};
export function relatif(ts, maintenant) {
  if (ts == null) return '—';
  relatifs[langue] ??= new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const jours = Math.round((ts - maintenant) / 86_400_000);
  if (Math.abs(jours) < 45) return relatifs[langue].format(jours, 'day');
  return relatifs[langue].format(Math.round(jours / 30.44), 'month');
}

// Le HTML statique porte data-i18n="cle" (texte) ou data-i18n-attr="attr:cle;attr:cle".
export function traduireDocument(racine = document) {
  for (const el of racine.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of racine.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of racine.querySelectorAll('[data-i18n-attr]')) {
    for (const paire of el.dataset.i18nAttr.split(';')) {
      const [attr, cle] = paire.split(':');
      if (attr && cle) el.setAttribute(attr.trim(), t(cle.trim()));
    }
  }
  for (const b of racine.querySelectorAll('[data-langue]')) {
    b.setAttribute('aria-pressed', String(b.dataset.langue === langue));
  }
}

// Sélecteur FR | EN | عربي : relie les boutons [data-langue] à un rappel.
export function brancherSelecteur(apres) {
  document.addEventListener('click', async (evt) => {
    const b = evt.target.closest('[data-langue]');
    if (!b) return;
    evt.preventDefault();
    await definirLangue(b.dataset.langue);
    if (apres) apres();
  });
}
