# Facoltativo. Riconosce una voce sola, quella di chi registra: dice quanto un audio somiglia a voci/campione.wav.
# Gira in un contenitore suo perché sherpa-onnx non ha un pacchetto per Alpine, il sistema di DiGiShare.
# Non esce verso Internet e legge solo la cartella audio di lavoro, in sola lettura.
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx
import soundfile as sf

CARTELLA = '/audio'
estrattore = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model='/voci/campplus.onnx', num_threads=1))


def impronta(file):
    dati, rate = sf.read(file, dtype='float32')
    flusso = estrattore.create_stream()
    flusso.accept_waveform(rate, dati)
    flusso.input_finished()
    if not estrattore.is_ready(flusso):
        return None
    v = np.array(estrattore.compute(flusso))
    return v / np.linalg.norm(v)


CAMPIONE = impronta('/voci/campione.wav')


class Pagina(BaseHTTPRequestHandler):
    def _rispondi(self, codice, dati):
        corpo = json.dumps(dati).encode()
        self.send_response(codice)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def do_GET(self):
        self._rispondi(200, {'ok': True})

    def do_POST(self):
        try:
            chiesta = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            nome = os.path.basename(str(chiesta.get('file', '')))
            percorso = os.path.join(CARTELLA, nome)
            if not nome or not os.path.isfile(percorso):
                return self._rispondi(404, {'error': 'File non trovato.'})
            v = impronta(percorso)
            self._rispondi(200, {'somiglianza': None if v is None else float(v @ CAMPIONE)})
        except Exception as err:  # il testo della nota vale anche senza nome: DiGiShare segnala e va avanti
            self._rispondi(500, {'error': str(err)[:200]})

    def log_message(self, *a):
        pass


ThreadingHTTPServer(('0.0.0.0', 8796), Pagina).serve_forever()
