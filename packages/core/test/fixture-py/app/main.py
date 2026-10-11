from fastapi import FastAPI

from app.api import runs
from .db import session

app = FastAPI()
app.include_router(runs.router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app)
