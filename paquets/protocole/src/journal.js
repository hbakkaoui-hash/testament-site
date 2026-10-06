// Journal chaîné (RG-C8) : chaque entrée porte l'empreinte de la précédente,
// toute falsification a posteriori casse la chaîne.
// La fonction de hachage est injectable ; le défaut (djb2) n'est PAS
// cryptographique — côté serveur, il sera remplacé par SHA-256.

export function hachageDefaut(chaine) {
  let h = 5381;
  for (let i = 0; i < chaine.length; i++) {
    h = ((h << 5) + h + chaine.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function empreinteDe(precedent, entree, hachage) {
  return hachage(precedent + JSON.stringify([entree.seq, entree.at, entree.type, entree.donnees]));
}

export function consigner(journal, { at, type, donnees = {} }, hachage = hachageDefaut) {
  const dernier = journal.length ? journal[journal.length - 1] : null;
  const precedent = dernier ? dernier.empreinte : 'GENESE';
  // La numérotation suit la dernière entrée : elle reste monotone après une
  // troncature, où les seq conservés ne partent plus de zéro.
  const entree = { seq: dernier ? dernier.seq + 1 : 0, at, type, donnees, precedent };
  entree.empreinte = empreinteDe(precedent, entree, hachage);
  journal.push(entree);
  return entree;
}

export function verifierJournal(journal, hachage = hachageDefaut) {
  // Un journal tronqué (BR-E-05) commence sur une entrée dont le précédent a
  // été supprimé : on l'accepte comme ancre et on vérifie la suite.
  let precedent = journal.length ? journal[0].precedent : 'GENESE';
  for (const entree of journal) {
    if (entree.precedent !== precedent) return { valide: false, seq: entree.seq };
    if (empreinteDe(precedent, entree, hachage) !== entree.empreinte) return { valide: false, seq: entree.seq };
    precedent = entree.empreinte;
  }
  return { valide: true };
}

// Troncature du journal après sa durée de conservation (BR-E-05).
// Les entrées retirées laissent une ancre : la chaîne repart de l'empreinte de
// la dernière entrée supprimée, ce qui reste vérifiable sans prétendre que rien
// n'a été retiré.
export function tronquerJournal(journal, { avantLe, at }, hachage = hachageDefaut) {
  const gardees = journal.filter((e) => e.at >= avantLe);
  const retirees = journal.length - gardees.length;
  if (retirees === 0) return 0;
  const derniere = journal[retirees - 1];
  journal.length = 0;
  journal.push(...gardees);
  consigner(journal, {
    at,
    type: 'JOURNAL_TRONQUE',
    donnees: { avantLe, entreesRetirees: retirees, derniereEmpreinteRetiree: derniere.empreinte },
  }, hachage);
  return retirees;
}
