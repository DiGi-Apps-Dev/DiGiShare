import { creaApp, leggiConfigurazione } from './app.js';

const config = leggiConfigurazione();
if (!config.chiave) {
  console.error('Manca DIGISHARE_AUTH_KEY nel file .env (32 byte in base64url). Vedi il README.');
  process.exit(1);
}
const { app, chiudi } = await creaApp(config);

const server = app.listen(config.porta, config.indirizzo, () => {
  console.log(`DiGiShare pronto su http://${config.indirizzo}:${config.porta}`);
});
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `La porta ${config.porta} è già occupata.` : err.message);
  process.exit(1);
});
// Le richieste di caricamento possono durare a lungo: niente tempo massimo sul singolo pezzo.
server.requestTimeout = 0;

function esci() {
  server.close(() => { chiudi(); process.exit(0); });
  server.closeAllConnections();
}
process.on('SIGINT', esci);
process.on('SIGTERM', esci);
