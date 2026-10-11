from .db import Base


class Run(Base):
    __tablename__ = "runs"


class CostLog(Base):
    __tablename__ = "cost_log"
