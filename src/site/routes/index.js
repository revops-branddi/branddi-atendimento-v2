/**
 * Site Routes — agregador. Montado em /api/site no server.js.
 *
 * Fluxo do site (lead clica em wa.me/<numero_dedicado> → conversa via WhatsApp)
 * é totalmente isolado do fluxo de prospecção em src/routes/. Schema DB
 * próprio em 'site.*'. Bot/integrações virão nas próximas fases.
 */
import { Router } from 'express';
import leadsRouter from './leads.js';
import conversationsRouter from './conversations.js';
import messagesRouter from './messages.js';
import whatsappAccountsRouter from './whatsapp-accounts.js';
import dashboardRouter from './dashboard.js';

const router = Router();

router.use(leadsRouter);
router.use(conversationsRouter);
router.use(messagesRouter);
router.use(whatsappAccountsRouter);
router.use(dashboardRouter);

export default router;
