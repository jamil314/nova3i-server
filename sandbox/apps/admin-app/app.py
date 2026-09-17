from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def root():
    return {"app": "admin-app", "status": "ok"}


@app.get("/health")
def health():
    return {"ok": True}