import anthropic

from ..db import session
from ..models import CostLog, Run

client = anthropic.Anthropic()


def start_run(company):
    session.add(Run(company=company))
    reply = client.messages.create(model="claude", messages=[])
    session.add(CostLog(cost=1))
    return Planner().plan(reply)


class Planner:
    def plan(self, goal):
        return self.score(goal)

    def score(self, goal):
        return len(goal)


def _private():
    return None
