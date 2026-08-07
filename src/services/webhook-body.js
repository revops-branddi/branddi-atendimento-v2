/**
 * Normaliza o corpo de webhook do Unipile.
 *
 * O Unipile registra os webhooks com `format: 'json'`, monta JSON, e entrega com
 * `content-type: application/x-www-form-urlencoded`. Isso quebrou de duas formas
 * seguidas, e a segunda so' foi visivel porque guardamos o corpo cru:
 *
 *   1. Com apenas express.json() montado, o corpo nao era parseado: req.body
 *      chegava {} e o handler caia no early-return de account_id, respondendo 200
 *      sem gravar. O Unipile via 200, concluia sucesso e nunca re-tentava — todos
 *      os eventos se perderam em silencio por meses.
 *
 *   2. Montando express.urlencoded(), o corpo passa a ser parseado — como
 *      formulario. A string JSON inteira vira o NOME de uma chave de valor vazio:
 *      `{ '{"event":"message_received",...}': '' }`. Continua sem account_id, e o
 *      handler continua descartando.
 *
 * Verificado contra payload real de producao em 2026-08-07.
 */

/**
 * @param {object|undefined} parsed  o que o body-parser produziu
 * @param {string|undefined} raw     os bytes como chegaram (via verify hook)
 * @returns {object} envelope utilizavel — nunca null/undefined
 */
export function normalizeWebhookBody(parsed, raw) {
    const base = (parsed && typeof parsed === 'object') ? parsed : {};

    // Se o parseado ja tem cara de envelope, e' porque veio com content-type
    // correto. Nao mexer.
    if (base.event || base.type || base.account_id || base.account) return base;

    if (typeof raw !== 'string' || raw.length === 0) return base;

    try {
        const doCru = JSON.parse(raw);
        // Array ou escalar no topo nao e' envelope: devolver isso faria o handler
        // acessar .account_id num tipo inesperado.
        if (doCru && typeof doCru === 'object' && !Array.isArray(doCru)) return doCru;
    } catch {
        // Corpo cru que nao e' JSON: fica com o que o parser entendeu.
    }

    return base;
}
