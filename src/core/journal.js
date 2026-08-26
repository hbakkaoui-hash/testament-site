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
  const precedent = journal.length ? journal[journal.length - 1].empreinte : 'GENESE';
  const entree = { seq: journal.length, at, type, donnees, precedent };
  entree.empreinte = empreinteDe(precedent, entree, hachage);
  journal.push(entree);
  return entree;
}

export function verifierJournal(journal, hachage = hachageDefaut) {
  let precedent = 'GENESE';
  for (const entree of journal) {
    if (entree.precedent !== precedent) return { valide: false, seq: entree.seq };
    if (empreinteDe(precedent, entree, hachage) !== entree.empreinte) return { valide: false, seq: entree.seq };
    precedent = entree.empreinte;
  }
  return { valide: true };
}
