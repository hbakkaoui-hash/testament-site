// Horloge injectable — aucune fonction du domaine n'appelle Date.now().
// Le temps est toujours passé en paramètre (ts en millisecondes UTC).

export function ajouterJours(ts, jours) {
  return ts + jours * 86_400_000;
}

// Arithmétique calendaire réelle : 31 janv + 1 mois → 28/29 févr (jour clampé).
export function ajouterMois(ts, mois) {
  const d = new Date(ts);
  const cible = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth() + mois, 1,
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(),
  ));
  const dernierJour = new Date(Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth() + 1, 0)).getUTCDate();
  cible.setUTCDate(Math.min(d.getUTCDate(), dernierJour));
  return cible.getTime();
}

export function creerHorloge(departISO = '2026-01-01T00:00:00Z') {
  let t = Date.parse(departISO);
  return {
    maintenant: () => t,
    avancerJours(jours) { t = ajouterJours(t, jours); return t; },
    avancerMois(mois) { t = ajouterMois(t, mois); return t; },
    allerA(iso) { t = Date.parse(iso); return t; },
  };
}
