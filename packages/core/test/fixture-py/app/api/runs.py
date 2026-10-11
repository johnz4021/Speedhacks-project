from fastapi import APIRouter

from app import models
from app.services.runner import start_run as begin

router = APIRouter()


@router.post("/api/runs")
def create_run(body: dict):
    return begin(body["company"])


@router.get("/api/runs/{run_id}")
async def get_run(run_id: str):
    return models.Run.objects.get(id=run_id)
