import os
import tarfile
import logging
import boto3
import torch
from flask import Flask, request, jsonify
from transformers import AutoTokenizer, AutoModelForSequenceClassification

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

S3_BUCKET = "karyaboard-ml-artifacts"
S3_KEY = "models/repo-predictor/model.tar.gz"
ARCHIVE_PATH = "/tmp/model.tar.gz"
EXTRACT_DIR = "/tmp/repo-predictor"

LABEL_MAP = {
    0: "node-express-api",
    1: "react-frontend",
    2: "python-ml",
    3: "fullstack-mern",
    4: "react-native-mobile",
}

tokenizer = None
model = None


def download_and_load_model():
    global tokenizer, model

    log.info("Downloading model from s3://%s/%s", S3_BUCKET, S3_KEY)
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.download_file(S3_BUCKET, S3_KEY, ARCHIVE_PATH)
    log.info("Download complete. Extracting to %s", EXTRACT_DIR)

    os.makedirs(EXTRACT_DIR, exist_ok=True)
    with tarfile.open(ARCHIVE_PATH, "r:gz") as tar:
        tar.extractall(EXTRACT_DIR)
    log.info("Extraction complete.")

    tokenizer = AutoTokenizer.from_pretrained(EXTRACT_DIR)
    model = AutoModelForSequenceClassification.from_pretrained(EXTRACT_DIR)
    model.eval()
    log.info("Model loaded and ready.")


app = Flask(__name__)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model_loaded": model is not None})


@app.route("/predict", methods=["POST"])
def predict():
    body = request.get_json(force=True, silent=True) or {}
    text = body.get("text", "").strip()
    if not text:
        return jsonify({"error": "text field is required"}), 400

    inputs = tokenizer(
        text,
        return_tensors="pt",
        max_length=64,
        truncation=True,
        padding=True,
    )

    with torch.no_grad():
        logits = model(**inputs).logits

    probs = torch.softmax(logits, dim=-1)[0]
    predicted_class = int(torch.argmax(probs).item())
    confidence = round(float(probs[predicted_class].item()), 4)
    template = LABEL_MAP.get(predicted_class, "node-express-api")

    return jsonify({"template": template, "confidence": confidence})


if __name__ == "__main__":
    download_and_load_model()
    app.run(host="0.0.0.0", port=5000)
