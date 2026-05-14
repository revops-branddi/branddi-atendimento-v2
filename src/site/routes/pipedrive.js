/**
 * Site Pipedrive lookups — endpoints read-only pra desambiguar Person/Org
 * antes do atendente criar um Deal. Objetivo é evitar duplicação:
 *
 *   - person-lookup por phone: descobre que o lead JÁ é cliente/prospect
 *     conhecido (talvez de outra origem ou outro atendente). Mostra na UI
 *     "🔗 Person já existe (#1234)" + deals abertos, antes do atendente
 *     clicar em "Criar deal" e gerar Person duplicada.
 *
 *   - org-search por termo: autocomplete do input Empresa. O fluxo antigo
 *     dependia de findOrCreateOrg(name) que casa nome literal — basta o
 *     atendente digitar "Branddi BR" em vez de "Branddi" pra criar Org
 *     duplicada. Com autocomplete, ele seleciona a row certa antes.
 */
import { Router } from 'express';
import * as pd from '../../services/pipedrive.js';
import logger from '../../services/logger.js';

const router = Router();

// ─── GET /pipedrive/person-lookup ────────────────────────────────────
// Procura Person no Pipedrive pelo phone do lead. Retorna { person, deals }
// ou { person: null } se não houver match.
router.get('/pipedrive/person-lookup', async (req, res) => {
    try {
        const phone = String(req.query.phone || '').trim();
        if (!phone) return res.status(400).json({ error: 'phone obrigatório' });

        const person = await pd.findPersonByPhone(phone);
        if (!person) return res.json({ person: null, deals: [] });

        // Deals da Person — útil pra UI mostrar se já tem negócio aberto.
        // best-effort: erro daqui não derruba o lookup.
        const deals = await pd.getDealsForPerson(person.id).catch(() => []);

        res.json({
            person: {
                id:       person.id,
                name:     person.name,
                email:    person.emails?.[0] || person.email || null,
                org_id:   person.organization?.id || person.org_id?.value || null,
                org_name: person.organization?.name || null,
                owner:    person.owner?.name || null,
            },
            deals: (deals || []).map(d => ({
                id:       d.id,
                title:    d.title,
                status:   d.status,
                stage_id: d.stage_id,
            })),
        });
    } catch (err) {
        logger.warn('site GET /pipedrive/person-lookup', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /pipedrive/org-search ───────────────────────────────────────
// Top N orgs por termo livre. Usado pelo autocomplete do input Empresa
// no painel de contato.
router.get('/pipedrive/org-search', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json({ items: [] });

        const items = await pd.searchOrganizations(q, 5);
        res.json({ items });
    } catch (err) {
        logger.warn('site GET /pipedrive/org-search', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

export default router;
