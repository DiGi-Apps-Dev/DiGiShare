import { crc32 } from 'node:zlib';

// Un archivio ZIP senza compressione: basta per il formato Word e non serve una libreria in più.
export function zipSync(file) {
  const locali = [];
  const centrali = [];
  let posizione = 0;
  for (const [nome, contenuto] of Object.entries(file)) {
    const n = Buffer.from(nome);
    const d = Buffer.from(contenuto);
    const crc = crc32(d);
    const testa = Buffer.alloc(30);
    testa.writeUInt32LE(0x04034b50, 0);
    testa.writeUInt16LE(20, 4);
    testa.writeUInt16LE(0x0800, 6);
    testa.writeUInt32LE(crc, 14);
    testa.writeUInt32LE(d.length, 18);
    testa.writeUInt32LE(d.length, 22);
    testa.writeUInt16LE(n.length, 26);
    locali.push(testa, n, d);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(d.length, 20);
    c.writeUInt32LE(d.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(posizione, 42);
    centrali.push(c, n);
    posizione += 30 + n.length + d.length;
  }
  const centro = Buffer.concat(centrali);
  const fine = Buffer.alloc(22);
  fine.writeUInt32LE(0x06054b50, 0);
  fine.writeUInt16LE(Object.keys(file).length, 8);
  fine.writeUInt16LE(Object.keys(file).length, 10);
  fine.writeUInt32LE(centro.length, 12);
  fine.writeUInt32LE(posizione, 16);
  return Buffer.concat([...locali, centro, fine]);
}
