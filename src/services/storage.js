/**
 * Upload de midia de saida via Supabase Storage.
 *
 * Por que existe: a Vercel limita o CORPO de request a 4,5 MB, e os diagnosticos
 * comerciais ja passam de 6 MB — e estao crescendo (apresentacoes de julho ficam
 * em 3,0-3,5 MB; diagnosticos de agosto, em 5,3-6,3 MB). Baixar o teto bloquearia
 * exatamente o documento que gera receita.
 *
 * O browser envia direto pro Storage (nao passa pela function) e a function so'
 * recebe a chave, baixa e repassa pro Unipile. O limite da Vercel e' sobre corpo
 * de request, nao sobre fetch de saida, entao o caminho de volta cabe.
 */
import { randomUUID } from 'node:crypto';
import sb from './supabase.js';

const BUCKET = 'outbound-media';
const PREFIX = 'outbound/';

/** `outbound/YYYY-MM-DD/<arquivo>` — um unico nivel de data, sem subdiretorio. */
const FORMATO = /^outbound\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+$/;

/**
 * A chave vem do cliente, entao e' entrada nao-confiavel. Sem esta validacao, um
 * atendente autenticado poderia mandar a function baixar qualquer objeto do
 * bucket e envia-lo por WhatsApp.
 *
 * O teste de `..` e' redundante com o regex — que ja nao aceita `/` no nome do
 * arquivo — mas fica explicito de proposito: se alguem afrouxar o regex depois,
 * a defesa contra traversal nao some junto.
 */
export function isValidObjectKey(key) {
    if (typeof key !== 'string' || key.length === 0) return false;
    if (!key.startsWith(PREFIX)) return false;
    if (key.includes('..')) return false;
    return FORMATO.test(key);
}

/**
 * @returns {Promise<{key:string, signedUrl:string}>} chave e URL pro browser subir.
 */
export async function createUploadUrl(fileName) {
    const seguro = String(fileName || 'arquivo').replace(/[^A-Za-z0-9._-]/g, '_');
    const dia = new Date().toISOString().slice(0, 10);
    const key = `${PREFIX}${dia}/${randomUUID()}-${seguro}`;

    const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(key);
    if (error) throw new Error(`storage: ${error.message}`);

    return { key, signedUrl: data.signedUrl };
}

/**
 * @returns {Promise<{buffer:Buffer, fileName:string}>} conteudo e nome original.
 */
export async function downloadObject(key) {
    if (!isValidObjectKey(key)) throw new Error('storage: chave invalida');

    const { data, error } = await sb.storage.from(BUCKET).download(key);
    if (error) throw new Error(`storage: ${error.message}`);

    const buffer = Buffer.from(await data.arrayBuffer());
    // Remove o uuid que createUploadUrl prefixou, devolvendo o nome que o
    // atendente escolheu — e' ele que o lead ve no WhatsApp.
    const fileName = key.split('/').pop().replace(/^[0-9a-f-]{36}-/, '');

    return { buffer, fileName };
}
