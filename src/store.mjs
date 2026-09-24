import { getStore } from '@netlify/blobs';
import { randomBytes } from 'node:crypto';

export const DEFAULT_TYPES = [
  ['management', '経営会議', 'Management Meeting', '#c0392b', 10],
  ['committee', 'バイオガス委員会', 'Biogas Committee', '#2874a6', 20],
  ['lecture', '講演会', 'Lecture / Seminar', '#7d3c98', 30],
  ['visitor', '来客対応', 'Visitor Reception', '#1e8449', 40],
  ['trip', '出張', 'Business Trip', '#b9770e', 50],
  ['exhibition', '展示会', 'Exhibition', '#117a65', 60],
  ['other', 'その他', 'Other', '#5d6d7e', 100],
];

export const newId = () => `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
export const nowIso = () => new Date().toISOString();

/**
 * Small document repository on top of Netlify Blobs.
 * Stores: members, types, events, materials (JSON docs) and files (binary).
 * On Netlify the stores are configured automatically; locally `server.mjs`
 * points the client at a file-backed BlobsServer.
 */
export function createStore() {
  const opts = { consistency: 'strong' };
  const stores = {
    members: getStore({ name: 'members', ...opts }),
    types: getStore({ name: 'types', ...opts }),
    events: getStore({ name: 'events', ...opts }),
    materials: getStore({ name: 'materials', ...opts }),
    files: getStore({ name: 'files', ...opts }),
    settings: getStore({ name: 'settings', ...opts }),
  };

  async function listKeys(name, prefix) {
    const { blobs } = await stores[name].list(prefix ? { prefix } : {});
    return blobs.map((b) => b.key);
  }
  async function listDocs(name, prefix) {
    const keys = await listKeys(name, prefix);
    const docs = await Promise.all(keys.map((k) => stores[name].get(k, { type: 'json' })));
    return docs.filter(Boolean);
  }
  const getDoc = (name, key) => stores[name].get(key, { type: 'json' });
  const putDoc = async (name, key, doc) => { await stores[name].setJSON(key, doc); return doc; };
  const delDoc = (name, key) => stores[name].delete(key);

  async function getTypes() {
    let types = await listDocs('types');
    if (!types.length) {
      types = DEFAULT_TYPES.map(([key, label_ja, label_en, color, sort_order]) => ({
        id: key, key, label_ja, label_en, color, sort_order, active: 1,
      }));
      await Promise.all(types.map((t) => putDoc('types', t.id, t)));
    }
    return types.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
  }
  async function getMembers() {
    const m = await listDocs('members');
    return m.sort((a, b) => a.side.localeCompare(b.side) || a.name.localeCompare(b.name, 'ja'));
  }

  return {
    listKeys, listDocs, getDoc, putDoc, delDoc, getTypes, getMembers,
    putFile: (key, data, metadata) => stores.files.set(key, data, { metadata }),
    getFile: (key) => stores.files.getWithMetadata(key, { type: 'arrayBuffer' }),
    delFile: (key) => stores.files.delete(key),
  };
}
