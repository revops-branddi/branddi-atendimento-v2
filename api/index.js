// Entrypoint da Vercel: reaproveita o mesmo app Express, sem escutar porta.
// O guard `if (!process.env.VERCEL)` em src/server.js e' o que impede o
// app.listen e os workers de setInterval de rodarem nesta importacao.
import app from '../src/server.js';

export default app;
