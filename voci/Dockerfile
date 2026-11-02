# Riconoscimento della voce di chi registra (facoltativo). Vedi voci/LEGGIMI.txt.
FROM python:3.12-slim
RUN pip install --no-cache-dir sherpa-onnx==2.0.1 soundfile==0.14.0 numpy==2.5.4
COPY campplus.onnx campione.wav servizio.py /voci/
USER 1000:100
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8796/', timeout=4)"
CMD ["python", "/voci/servizio.py"]
