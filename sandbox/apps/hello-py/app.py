from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def root():
    return {"app": "hello-py", "status": "ok"}


@app.get("/hello")
def hello():
    return {"message": "hello from python"}


@app.get("/health")
def health():
    return {"ok": True}
