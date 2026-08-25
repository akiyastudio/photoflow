"""Small registry used only by the plugin's imported legacy modules."""
from collections import defaultdict
from dataclasses import dataclass, field

@dataclass
class LegacyDomain:
    actions: dict = field(default_factory=dict)
    integrated_actions: set = field(default_factory=set)
    hooks: dict = field(default_factory=lambda: defaultdict(list))

_domains=[]; _tools={}; _exports={}
def register_domain(domain): _domains.append(domain)
def register_tool(name,module): _tools.setdefault(name,module)
def register_exports(role,values): _exports.setdefault(role,{}).update(values)
