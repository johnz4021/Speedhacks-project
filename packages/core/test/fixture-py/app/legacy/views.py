from flask import Blueprint

from .items import Item

bp = Blueprint("legacy", __name__)


@bp.route("/legacy/<int:item_id>", methods=["GET", "DELETE"])
def item(item_id, cursor=None):
    Item.objects.filter(id=item_id).delete()
    cursor.execute("INSERT INTO audit_log (item) VALUES (%s)", [item_id])
    return "ok"
