// The manager's dashboard is a JSON tree, never HTML. Only these node types, these fields and
// these actions get through; everything else is dropped. The page renders the result as text.
const ACTIONS = new Set(['ask_agent', 'answer', 'open_console', 'open_chat', 'refresh']);
const str = (v, n = 400) => (typeof v === 'string' ? v.slice(0, n) : '');

export function validateSpec(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) return null;
  const kids = () => (Array.isArray(node.children) ? node.children.slice(0, 40).map((c) => validateSpec(c, depth + 1)).filter(Boolean) : []);
  const action = () => (ACTIONS.has(node.action) ? node.action : null);
  const args = () => ({ terminal: /^[\w-]{1,32}$/.test(node.args?.terminal || '') ? node.args.terminal : '', id: /^[\w-]{1,12}$/.test(node.args?.id || '') ? node.args.id : '' });
  switch (node.type) {
    case 'stack': return { type: 'stack', children: kids() };
    case 'stats': return { type: 'stats', items: (Array.isArray(node.items) ? node.items : []).slice(0, 6).map((i) => ({ label: str(i?.label, 30), value: str(String(i?.value ?? ''), 30) })) };
    case 'card': return { type: 'card', title: str(node.title, 100), subtitle: str(node.subtitle, 200), badge: str(node.badge, 20), text: str(node.text, 600), children: kids() };
    case 'session': return /^[\w-]{1,12}$/.test(node.id || '') ? { type: 'session', id: node.id } : null; // drawn live from the fleet, so it never goes stale
    case 'text': return { type: 'text', text: str(node.text, 800) };
    case 'list': return { type: 'list', items: (Array.isArray(node.items) ? node.items : []).slice(0, 20).map((s) => str(s, 200)) };
    case 'button': return action() ? { type: 'button', label: str(node.label, 40), action: action(), args: args() } : null;
    case 'input': return action() ? { type: 'input', placeholder: str(node.placeholder, 80), action: action(), args: args() } : null;
    default: return null;
  }
}
