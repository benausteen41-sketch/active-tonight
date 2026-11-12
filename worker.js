// ACTIVE TONIGHT — single-file Cloudflare Worker (website + Korapay payment API).
// GENERATED FILE: do not edit by hand. Replace this whole file when a new version is sent.

// ===== shared helpers =====
// Shared helpers for Cloudflare Pages Functions (Workers runtime).
// Secrets come from Cloudflare environment variables, never from client code.

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function commissionRate(env) {
  const r = Number(env.COMMISSION_RATE ?? 0.05);
  return Number.isFinite(r) && r >= 0 && r < 1 ? r : 0.05;
}

const base = (env) => env.SUPABASE_URL.replace(/\/$/, "");

// Validate a customer's Supabase session token.
async function getUser(env, token) {
  if (!token) return null;
  const r = await fetch(base(env) + "/auth/v1/user", {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

// Service-role REST call (trusted server code only).
async function rest(env, path, { method = "GET", body, prefer } = {}) {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(base(env) + "/rest/v1/" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error((data && (data.message || data.hint)) || "Database error");
  return data;
}

const rpc = (env, fn, args) =>
  rest(env, "rpc/" + fn, { method: "POST", body: args });

async function koraFetch(env, path, options = {}) {
  const r = await fetch("https://api.korapay.com/merchant/api/v1" + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + env.KORAPAY_SECRET_KEY,
      "Content-Type": "application/json",
    },
  });
  let data = null;
  try { data = await r.json(); } catch (_) {}
  return { ok: r.ok, data };
}

const enc = new TextEncoder();
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Confirms a payment with Korapay, then issues tickets through one atomic
// database function. Safe to call many times (return page, webhook, retries).
async function confirmAndFulfil(env, reference) {
  const orders = await rest(
    env,
    `orders?payment_reference=eq.${encodeURIComponent(reference)}&select=id,total_amount,payment_status`
  );
  const order = orders && orders[0];
  if (!order) return { ok: false, error: "Order record was not found." };
  if (order.payment_status === "paid") return { ok: true, already: true };
  if (order.payment_status === "needs_refund" || order.payment_status === "refunded")
    return { ok: false, error: "This order needs attention. Please contact support with your payment reference." };

  const { data } = await koraFetch(env, "/charges/" + encodeURIComponent(reference));
  const d = data && data.data;
  if (!data || !data.status || !d) return { ok: false, pending: true, error: "Payment not confirmed yet." };
  if (d.status === "processing" || d.status === "pending")
    return { ok: false, pending: true, error: "Payment is still processing." };
  if (d.status !== "success") return { ok: false, error: "Payment was not successful." };
  if (d.reference && d.reference !== reference) return { ok: false, error: "Reference mismatch." };
  if (d.currency && d.currency !== "NGN") return { ok: false, error: "Unexpected payment currency." };

  const result = await rpc(env, "fulfil_order", {
    p_reference: reference,
    p_amount_paid: Number(d.amount),
  });
  const status = result && result.status;
  if (status === "paid" || status === "already_paid") return { ok: true };
  if (status === "amount_mismatch") return { ok: false, error: "Payment amount does not match the order. Contact support." };
  if (status === "needs_refund") return { ok: false, error: "This event sold out before your payment completed. You will be refunded; contact support with your reference." };
  return { ok: false, error: "Could not issue tickets. Contact support with your payment reference." };
}

// ===== /api/korapay-initialize =====

async function handleInitialize({ request, env }) {
  let orderRef = null;
  try {
    const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const user = await getUser(env, token);
    if (!user) return json({ error: "Please sign in first." }, 401);

    const body = await request.json().catch(() => ({}));
    const qty = Number(body.quantity);
    const eventId = String(body.event_id || "");
    if (!/^[0-9a-f-]{36}$/i.test(eventId) || !Number.isInteger(qty) || qty < 1 || qty > 10)
      throw new Error("Invalid event or ticket quantity.");

    const evs = await rest(env, `events?id=eq.${eventId}&select=id,title,price,status,starts_at,capacity,tickets_sold`);
    const ev = evs && evs[0];
    if (!ev || ev.status !== "published" || new Date(ev.starts_at) <= new Date())
      throw new Error("This event is not available for booking.");
    if (ev.capacity !== null && ev.tickets_sold + qty > ev.capacity) {
      const left = Math.max(0, ev.capacity - ev.tickets_sold);
      throw new Error(left ? `Only ${left} ticket(s) left for this event.` : "This event is sold out.");
    }

    const total = round2(Number(ev.price) * qty);
    const rate = commissionRate(env);
    const fee = round2(total * rate);
    const reference = "AT-" + crypto.randomUUID();
    orderRef = reference;

    // Create the order BEFORE sending the customer to pay, so a payment can never exist without an order.
    await rest(env, "orders", {
      method: "POST",
      prefer: "return=minimal",
      body: {
        event_id: ev.id, user_id: user.id, quantity: qty,
        unit_price: ev.price, total_amount: total,
        commission_rate: rate, platform_fee: fee, organizer_amount: round2(total - fee),
        payment_reference: reference, payment_status: "pending", gateway: "korapay",
      },
    });

    // Free events: issue tickets immediately, no gateway.
    if (total === 0) {
      const r = await rpc(env, "fulfil_order", { p_reference: reference, p_amount_paid: 0 });
      if (!r || (r.status !== "paid" && r.status !== "already_paid")) throw new Error("This event just sold out.");
      return json({ free: true, reference });
    }

    const origin = new URL(request.url).origin;
    const { ok, data } = await koraFetch(env, "/charges/initialize", {
      method: "POST",
      body: JSON.stringify({
        reference,
        amount: total,
        currency: "NGN",
        narration: ("Tickets: " + ev.title).slice(0, 100),
        redirect_url: origin + "/payment-success.html",
        notification_url: origin + "/api/korapay-webhook",
        customer: { name: (user.user_metadata && user.user_metadata.full_name) || user.email, email: user.email },
        metadata: { event_id: ev.id, user_id: user.id, quantity: qty },
      }),
    });
    const url = data && data.data && data.data.checkout_url;
    if (!ok || !data.status || !url) throw new Error((data && data.message) || "Korapay could not start the payment.");
    return json({ authorization_url: url, reference });
  } catch (e) {
    if (orderRef) {
      try { await rest(env, `orders?payment_reference=eq.${orderRef}&payment_status=eq.pending`, { method: "PATCH", prefer: "return=minimal", body: { payment_status: "failed" } }); } catch (_) {}
    }
    return json({ error: e.message || "Could not start payment." }, 400);
  }
}

// ===== /api/korapay-verify =====

// Called by payment-success.html after Korapay redirects the buyer back.
async function handleVerify({ request, env }) {
  try {
    const reference = new URL(request.url).searchParams.get("reference") || "";
    if (!/^AT-[0-9a-f-]{36}$/i.test(reference)) return json({ success: false, error: "Missing or invalid payment reference." }, 400);
    const r = await confirmAndFulfil(env, reference);
    if (r.ok) return json({ success: true, message: "Payment confirmed. Your tickets are ready." });
    return json({ success: false, pending: !!r.pending, error: r.error }, r.pending ? 202 : 400);
  } catch (e) {
    return json({ success: false, error: "Verification could not be completed. Please contact support with your payment reference." }, 500);
  }
}

// ===== /api/korapay-webhook =====

// Korapay signs ONLY the `data` object with your secret key (HMAC-SHA256, hex).
async function handleWebhook({ request, env }) {
  let body;
  try { body = JSON.parse(await request.text()); } catch (_) { return json({ error: "Bad payload" }, 400); }

  const expected = await hmacHex(env.KORAPAY_SECRET_KEY, JSON.stringify(body && body.data));
  if (!safeEqual(request.headers.get("x-korapay-signature") || "", expected))
    return json({ error: "Invalid signature" }, 401);

  const ref = body.data && body.data.reference;
  if (typeof ref !== "string" || !/^AT-[0-9a-f-]{36}$/i.test(ref)) return json({ ok: true }); // not ours

  try {
    if (body.event === "charge.success") {
      // Re-verified with Korapay inside; fulfilment is idempotent.
      await confirmAndFulfil(env, ref);
    } else if (body.event === "charge.failed") {
      await rest(env, `orders?payment_reference=eq.${encodeURIComponent(ref)}&payment_status=eq.pending`, {
        method: "PATCH", prefer: "return=minimal", body: { payment_status: "failed" },
      });
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: "Temporary error" }, 500); // non-2xx makes Korapay retry
  }
}

// ===== website files =====
const SITE = {"/app.js": ["const SUPABASE_URL=\"https://dozcoowqzcjyzmolhmhb.supabase.co\";\nconst SUPABASE_KEY=\"sb_publishable_n8wI2SpwYPlKu_fzVQM9sA_LH-hJCo4\";\nconst supabase=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY);\nlet currentUser=null,category=\"\",allEvents=[];\nconst $=id=>document.getElementById(id);\nconst money=n=>Number(n)===0?\"Free\":\"₦\"+Number(n||0).toLocaleString(\"en-NG\");\nconst dateText=d=>new Date(d).toLocaleString(\"en-NG\",{weekday:\"short\",month:\"short\",day:\"numeric\",hour:\"numeric\",minute:\"2-digit\"});\nconst safe=s=>String(s??\"\").replace(/[&<>\"']/g,c=>({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"}[c]));\nfunction toast(s){$(\"toast\").textContent=s;$(\"toast\").classList.add(\"show\");setTimeout(()=>$(\"toast\").classList.remove(\"show\"),3300)}\nfunction modal(html){$(\"modalContent\").innerHTML=html;$(\"modal\").hidden=false}\nfunction closeModal(){$(\"modal\").hidden=true}\nconst FALLBACK_COVER=\"https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=900&q=80\";\nfunction coverUrl(u){try{const x=new URL(u);if(x.protocol!==\"https:\")return FALLBACK_COVER;return x.href.replace(/['\"()\\\\\\s<>]/g,c=>\"%\"+c.charCodeAt(0).toString(16).toUpperCase().padStart(2,\"0\"))}catch{return FALLBACK_COVER}}\nfunction remaining(e){return e.capacity==null?null:Math.max(0,e.capacity-(e.tickets_sold||0))}\nasync function loadEvents(){let {data,error}=await supabase.from(\"events\").select(\"*\").eq(\"status\",\"published\").gte(\"starts_at\",new Date().toISOString()).order(\"starts_at\").limit(100);if(error){console.warn(error.message);$(\"events\").innerHTML='<p class=\"muted\">We could not load events right now. Please refresh in a moment.</p>';return}allEvents=data||[];renderEvents()}\nfunction renderEvents(){let q=$(\"query\").value.toLowerCase(),city=$(\"city\").value,sort=$(\"sort\").value;let list=allEvents.filter(e=>(!category||e.category===category)&&(!city||e.city===city)&&(!q||[e.title,e.city,e.venue,e.category].join(\" \").toLowerCase().includes(q)));if(sort===\"popular\")list.sort((a,b)=>(b.popularity||0)-(a.popularity||0));else list.sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at));$(\"events\").innerHTML=list.map(e=>`<article class=\"event\" data-id=\"${safe(e.id)}\"><div class=\"cover\" style=\"background-image:url('${safe(coverUrl(e.cover_url))}')\"><span class=\"tag\">${safe(e.category||\"EVENT\")}</span></div><div class=\"event-body\"><h3>${safe(e.title)}</h3><p>◷ ${dateText(e.starts_at)}</p><p>⌖ ${safe(e.venue||e.city)} · ${safe(e.city)}</p><div class=\"event-foot\"><span class=\"price\">${money(e.price)}</span><b>${remaining(e)===0?\"Sold out\":\"View event ↗\"}</b></div></div></article>`).join(\"\");$(\"empty\").hidden=!!list.length;document.querySelectorAll(\".event\").forEach(el=>el.onclick=()=>eventDetails(el.dataset.id))}\nfunction eventDetails(id){let e=allEvents.find(x=>String(x.id)===String(id));if(!e)return;let left=remaining(e),max=left===null?10:Math.min(10,left);modal(`<div class=\"eyebrow\">${safe(e.category||\"EVENT\")} · ${safe(e.city)}</div><h2>${safe(e.title)}</h2><p>◷ ${dateText(e.starts_at)}<br>⌖ ${safe(e.venue||\"Venue to be announced\")}</p><p>${safe(e.description||\"Get ready for a great night. Check the event details with the organizer before attending.\")}</p><div class=\"ticket\"><strong>${money(e.price)} <small>per ticket</small></strong><small>Digital ticket issued after confirmed payment.</small></div>${max?`<label>Number of tickets<select id=\"ticketQty\">${Array.from({length:max},(_,i)=>`<option>${i+1}</option>`).join(\"\")}</select></label><button class=\"primary\" id=\"buyTicket\">Continue to payment</button>`:`<button class=\"primary\" disabled>Sold out</button>`}<p id=\"payMessage\"></p>`);if($(\"buyTicket\"))$(\"buyTicket\").onclick=()=>beginCheckout(e)}\nasync function beginCheckout(e){if(!currentUser){toast(\"Please log in or create an account first.\");closeModal();authForm(\"login\");return}let qty=Number($(\"ticketQty\").value);let btn=$(\"buyTicket\");btn.disabled=true;btn.textContent=\"Preparing secure checkout…\";try{let session=(await supabase.auth.getSession()).data.session;if(!session)throw Error(\"Your session expired. Please log in again.\");let r=await fetch(\"/api/korapay-initialize\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\",\"Authorization\":\"Bearer \"+session.access_token},body:JSON.stringify({event_id:e.id,quantity:qty})});let j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||\"Could not start payment\");if(j.free){closeModal();toast(\"Your free ticket is ready.\");loadEvents();tickets();return}location.href=j.authorization_url}catch(err){$(\"payMessage\").textContent=err.message;btn.disabled=false;btn.textContent=\"Continue to payment\"}}\nfunction authForm(mode){modal(`<div class=\"eyebrow\">ACTIVE TONIGHT ACCOUNT</div><h2>${mode===\"signup\"?\"Create your account\":\"Welcome back\"}</h2><form id=\"authForm\">${mode===\"signup\"?'<label>Full name<input id=\"name\" required></label>':\"\"}<label>Email<input id=\"email\" type=\"email\" required></label><label>Password<input id=\"password\" type=\"password\" minlength=\"6\" required></label><button class=\"primary\">${mode===\"signup\"?\"Create account\":\"Log in\"}</button><p id=\"authMsg\"></p></form><p><a href=\"#\" id=\"switchAuth\">${mode===\"signup\"?\"Already have an account? Log in\":\"New to Active Tonight? Create account\"}</a></p>`);$(\"switchAuth\").onclick=ev=>{ev.preventDefault();authForm(mode===\"signup\"?\"login\":\"signup\")};$(\"authForm\").onsubmit=async ev=>{ev.preventDefault();let email=$(\"email\").value,password=$(\"password\").value;let result=mode===\"signup\"?await supabase.auth.signUp({email,password,options:{data:{full_name:$(\"name\").value}}}):await supabase.auth.signInWithPassword({email,password});if(result.error){$(\"authMsg\").textContent=result.error.message;return}if(mode===\"signup\"&&!result.data.session){$(\"authMsg\").textContent=\"Check your email to confirm your account, then log in.\";return}currentUser=result.data.user;closeModal();updateHeader();toast(\"You're signed in.\")}}\nfunction updateHeader(){$(\"login\").textContent=currentUser?\"Account\":\"Log in\";$(\"signup\").textContent=currentUser?\"Log out\":\"Join Active Tonight ↗\"}\nasync function tickets(){if(!currentUser){authForm(\"login\");return}let {data,error}=await supabase.from(\"tickets\").select(\"id,ticket_code,status,created_at,event:events(title,starts_at,venue,city)\").eq(\"user_id\",currentUser.id).order(\"created_at\",{ascending:false});if(error){toast(\"Ticket history is not available yet.\");console.warn(error);return}modal(`<div class=\"eyebrow\">YOUR NIGHT OUT</div><h2>My tickets</h2>${(data||[]).length?data.map(t=>`<div class=\"ticket\"><strong>${safe(t.event?.title||\"Event\")}</strong><small>${safe(t.event?.venue||\"\")} · ${safe(t.event?.city||\"\")}<br>${t.event?.starts_at?dateText(t.event.starts_at):\"\"} · ${safe(t.status)}</small><p>Ticket code: <b>${safe(t.ticket_code)}</b></p></div>`).join(\"\"):\"<p>You haven't purchased any tickets yet. Explore events and book your next night out.</p>\"}`)}\nasync function createEventForm(){if(!currentUser){authForm(\"login\");return}modal(`<div class=\"eyebrow\">ORGANIZER STUDIO</div><h2>Submit an event</h2><p>Your event will be reviewed before it appears publicly.</p><form id=\"eventForm\"><label>Event name<input id=\"title\" required maxlength=\"100\"></label><label>Category<select id=\"cat\"><option>Parties</option><option>Nightclubs</option><option>Concerts</option><option>Lounges</option><option>Festivals</option></select></label><label>City<input id=\"eventCity\" required placeholder=\"e.g. Warri\"></label><label>Venue<input id=\"venue\" required></label><label>Event date and time<input id=\"starts\" type=\"datetime-local\" required></label><label>Ticket price in naira<input id=\"price\" type=\"number\" min=\"0\" step=\"100\" value=\"0\" required></label><label>Ticket capacity (leave empty for unlimited)<input id=\"capacity\" type=\"number\" min=\"1\" step=\"1\"></label><label>Event poster image URL<input id=\"cover\" type=\"url\" placeholder=\"https://...\"></label><label>Description<textarea id=\"description\"></textarea></label><button class=\"primary\">Submit for review</button><p id=\"eventMsg\"></p></form>`);$(\"eventForm\").onsubmit=async ev=>{ev.preventDefault();let b=ev.submitter;b.disabled=true;let starts=new Date($(\"starts\").value);if(!(starts>new Date())){$(\"eventMsg\").textContent=\"Choose a future date and time.\";b.disabled=false;return}let cv=$(\"cover\").value.trim();if(cv&&!/^https:\\/\\//i.test(cv)){$(\"eventMsg\").textContent=\"Poster link must start with https://\";b.disabled=false;return}let row={organizer_id:currentUser.id,title:$(\"title\").value,category:$(\"cat\").value,city:$(\"eventCity\").value,venue:$(\"venue\").value,starts_at:starts.toISOString(),capacity:$(\"capacity\").value?Number($(\"capacity\").value):null,price:Number($(\"price\").value),cover_url:cv||null,description:$(\"description\").value,status:\"pending\"};let {error}=await supabase.from(\"events\").insert(row);if(error){$(\"eventMsg\").textContent=error.message;b.disabled=false;return}modal(\"<h2>Event submitted!</h2><p>Your event is awaiting administrator review. It will appear publicly once approved.</p>\");toast(\"Event submitted for review.\")}}\ndocument.querySelectorAll(\".chip\").forEach(b=>b.onclick=()=>{category=b.dataset.cat;document.querySelectorAll(\".chip\").forEach(x=>x.classList.toggle(\"selected\",x===b));renderEvents()});\n$(\"search\").onclick=renderEvents;$(\"query\").oninput=renderEvents;$(\"city\").onchange=renderEvents;$(\"sort\").onchange=renderEvents;$(\"login\").onclick=()=>currentUser?modal(`<h2>Account</h2><p>${safe(currentUser.email)}</p><button class=\"primary\" id=\"logout\">Log out</button>`):authForm(\"login\");$(\"signup\").onclick=()=>currentUser?supabase.auth.signOut().then(()=>toast(\"Logged out\")):authForm(\"signup\");$(\"myTickets\").onclick=tickets;$(\"createEvent\").onclick=createEventForm;$(\"close\").onclick=closeModal;$(\"modal\").onclick=e=>{if(e.target===$(\"modal\"))closeModal()};$(\"mobileMenu\").onclick=()=>{modal(`<div class=\"eyebrow\">MENU</div><h2>Active Tonight</h2><div class=\"menu-links\"><a href=\"#discover\" data-menu>Discover events</a><a href=\"#organizer\" data-menu>For organizers</a><button class=\"ghost\" id=\"mmTickets\">My tickets</button><button class=\"ghost\" id=\"mmLogin\">${currentUser?\"Account\":\"Log in\"}</button><button class=\"primary\" id=\"mmCreate\">List your event ↗</button></div>`);document.querySelectorAll(\"[data-menu]\").forEach(a=>a.onclick=closeModal);$(\"mmTickets\").onclick=()=>{closeModal();tickets()};$(\"mmLogin\").onclick=()=>{closeModal();$(\"login\").click()};$(\"mmCreate\").onclick=()=>{closeModal();createEventForm()}};$(\"year\").textContent=new Date().getFullYear();\nsupabase.auth.getSession().then(({data})=>{currentUser=data.session?.user||null;updateHeader()});supabase.auth.onAuthStateChange((_e,s)=>{currentUser=s?.user||null;updateHeader()});\ndocument.addEventListener(\"click\",e=>{if(e.target.id===\"logout\")supabase.auth.signOut().then(()=>{closeModal();toast(\"Logged out\")})});\nloadEvents();\n$(\"modal\").addEventListener(\"click\",e=>{if(e.target.id===\"modal\")closeModal()});document.addEventListener(\"keydown\",e=>{if(e.key===\"Escape\")closeModal()});\n", "text/javascript; charset=utf-8"], "/index.html": ["<!doctype html>\n<html lang=\"en\"><head>\n<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<meta name=\"theme-color\" content=\"#09070f\"><title>Active Tonight — Find Your Vibe. Own Your Night.</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\"><link href=\"https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap\" rel=\"stylesheet\">\n<link rel=\"stylesheet\" href=\"styles.css\"><script src=\"https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2\"></script>\n</head><body>\n<header class=\"top\"><a class=\"brand\" href=\"#\"><span class=\"mark\">✦</span><span>ACTIVE <b>TONIGHT</b><small>FIND YOUR VIBE. OWN YOUR NIGHT.</small></span></a>\n<nav><a href=\"#discover\">Discover</a><a href=\"#organizer\">For organizers</a></nav>\n<div class=\"top-actions\"><button class=\"ghost\" id=\"myTickets\">My tickets</button><button class=\"ghost\" id=\"login\">Log in</button><button class=\"primary\" id=\"signup\">Join Active Tonight ↗</button></div><button class=\"mobile-menu\" id=\"mobileMenu\">☰</button></header>\n<main>\n<section class=\"hero wrap\"><div><div class=\"eyebrow\">YOUR CITY. YOUR NIGHT. YOUR SCENE.</div><h1>Make tonight<br><span>unforgettable.</span></h1><p>Discover the best parties, concerts, lounges and experiences happening around you.</p>\n<div class=\"search\"><input id=\"query\" placeholder=\"Search events, venues or artists\"><select id=\"city\"><option value=\"\">All cities</option><option>Lagos</option><option>Warri</option><option>Asaba</option><option>Abraka</option><option>Benin City</option><option>Abuja</option><option>Port Harcourt</option></select><button class=\"primary\" id=\"search\">Explore events</button></div>\n<div class=\"proof\"><span>✦ Curated experiences</span><span>◉ Across Nigeria</span><span>✓ Secure ticketing</span></div></div><div class=\"hero-art\"><div class=\"hero-photo\"></div><div class=\"float-card\"><b>THE NIGHT IS YOURS</b><small>Find what's happening near you.</small></div></div></section>\n<section class=\"wrap\" id=\"discover\"><div class=\"section-head\"><div><div class=\"eyebrow\">FIND YOUR VIBE</div><h2>Explore events</h2></div><select id=\"sort\"><option value=\"soon\">Soonest first</option><option value=\"popular\">Popular first</option></select></div>\n<div class=\"filters\" id=\"categories\"><button class=\"chip selected\" data-cat=\"\">All events</button><button class=\"chip\" data-cat=\"Nightclubs\">Nightclubs</button><button class=\"chip\" data-cat=\"Concerts\">Concerts</button><button class=\"chip\" data-cat=\"Parties\">Parties</button><button class=\"chip\" data-cat=\"Lounges\">Lounges</button><button class=\"chip\" data-cat=\"Festivals\">Festivals</button></div>\n<div id=\"events\" class=\"grid\"><p class=\"muted\">Loading events…</p></div><p class=\"muted center\" id=\"empty\" hidden>No events match those filters yet.</p></section>\n<section class=\"organizer wrap\" id=\"organizer\"><div><div class=\"eyebrow\">FOR EVENT ORGANIZERS</div><h2>Your event deserves<br><span>a bigger crowd.</span></h2><p>Create an organizer account, submit your event and reach people looking for their next great night out.</p><button class=\"primary\" id=\"createEvent\">List your event ↗</button></div><div class=\"orb\">AT<sup>✦</sup></div></section>\n</main>\n<footer class=\"wrap footer\"><a class=\"brand\" href=\"#\"><span class=\"mark\">✦</span><span>ACTIVE <b>TONIGHT</b><small>FIND YOUR VIBE. OWN YOUR NIGHT.</small></span></a><span>© <span id=\"year\"></span> Active Tonight</span></footer>\n<div class=\"overlay\" id=\"modal\" hidden><section class=\"dialog\"><button class=\"close\" id=\"close\">×</button><div id=\"modalContent\"></div></section></div><div id=\"toast\" class=\"toast\"></div>\n<script src=\"app.js\"></script></body></html>", "text/html; charset=utf-8"], "/payment-success.html": ["<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Confirming ticket — Active Tonight</title><link rel=\"stylesheet\" href=\"styles.css\"></head><body><main class=\"wrap\" style=\"padding:90px 0;max-width:650px\"><div class=\"eyebrow\">ACTIVE TONIGHT CHECKOUT</div><h1 style=\"font:700 42px 'Space Grotesk'\">Confirming your payment…</h1><p id=\"status\" class=\"muted\">Please keep this page open while we confirm your payment.</p><p id=\"ref\" class=\"muted\"></p><a class=\"primary\" href=\"/\" style=\"display:inline-block;margin-top:20px\">Back to Active Tonight</a></main><script src=\"payment-success.js\"></script></body></html>\n", "text/html; charset=utf-8"], "/payment-success.js": ["const ref = new URLSearchParams(location.search).get(\"reference\");\nconst el = document.getElementById(\"status\");\nconst heading = document.querySelector(\"h1\");\nlet tries = 0;\nif (!ref) {\n  heading.textContent = \"No payment found\";\n  el.textContent = \"No payment reference was supplied. Please contact support.\";\n} else {\n  document.getElementById(\"ref\").textContent = \"Payment reference: \" + ref;\n  check();\n}\nasync function check() {\n  try {\n    const r = await fetch(\"/api/korapay-verify?reference=\" + encodeURIComponent(ref));\n    const j = await r.json();\n    if (j.success) {\n      heading.textContent = \"You're in!\";\n      el.textContent = \"Payment confirmed. Your tickets have been added to My tickets.\";\n      return;\n    }\n    if (j.pending && tries++ < 10) { setTimeout(check, 3000); return; } // webhook/bank can lag a few seconds\n    heading.textContent = \"We couldn't confirm it yet\";\n    el.textContent = j.error || \"Please contact support with your payment reference.\";\n  } catch (_) {\n    heading.textContent = \"We couldn't confirm it yet\";\n    el.textContent = \"Verification could not be completed. Please contact support with your payment reference.\";\n  }\n}\n", "text/javascript; charset=utf-8"], "/styles.css": ["*{box-sizing:border-box}[hidden]{display:none!important} :root{--bg:#09070f;--panel:#171321;--line:#30263b;--muted:#aaa1b5;--purple:#a51aff;--orange:#ff8a1d}body{margin:0;background:var(--bg);color:#fff;font-family:\"DM Sans\",sans-serif}a{color:inherit;text-decoration:none}button,input,select,textarea{font:inherit}.wrap{width:min(1120px,calc(100% - 40px));margin:auto}.top{height:78px;display:flex;align-items:center;justify-content:space-between;padding:0 max(20px,calc((100% - 1120px)/2));border-bottom:1px solid #ffffff14;position:sticky;top:0;background:#09070feF;backdrop-filter:blur(16px);z-index:5}.brand{display:flex;align-items:center;gap:10px;font:700 15px \"Space Grotesk\"}.brand b{display:block;color:#c34bff}.brand small{display:block;font:600 8px \"DM Sans\";letter-spacing:1.4px;color:#94899e;margin-top:4px}.mark{font-size:30px;color:var(--orange)}nav{display:flex;gap:28px;color:#c8c0d0;font-size:13px}.top-actions{display:flex;gap:9px}.ghost,.primary,.chip{border-radius:8px;padding:11px 15px;font-weight:700;font-size:12px;cursor:pointer}.ghost{border:1px solid #51465d;background:none;color:#fff}.primary{border:0;background:linear-gradient(110deg,#8d12e9,#c22bff);color:white}.primary:disabled{opacity:.55;cursor:wait}.mobile-menu{display:none;background:none;color:#fff;border:0;font-size:22px}.hero{display:grid;grid-template-columns:1.1fr .9fr;gap:40px;align-items:center;padding-top:75px;padding-bottom:85px}.eyebrow{font-size:10px;letter-spacing:2px;color:#ce8aff;font-weight:800}.hero h1{font:700 clamp(54px,7vw,82px)/.99 \"Space Grotesk\";letter-spacing:-4px;margin:22px 0}.hero h1 span,.organizer h2 span{background:linear-gradient(90deg,#a51aff,#e03bff,#ff8a1d);background-clip:text;color:transparent}.hero p,.organizer p{color:#b4abba;line-height:1.7;max-width:490px}.search{display:flex;gap:7px;padding:7px;background:var(--panel);border:1px solid #493852;border-radius:11px;margin-top:25px}.search input{flex:1;min-width:80px;background:none;border:0;outline:0;color:white;padding:0 10px;font-size:12px}.search select, #sort{background:#171321;color:#ddd;border:1px solid #3b3045;border-radius:7px;padding:10px;font-size:12px}.proof{display:flex;gap:20px;color:#8e8599;font-size:10px;margin-top:20px}.hero-art{height:350px;position:relative}.hero-photo{position:absolute;inset:0;border-radius:22px;background:linear-gradient(0deg,#09070f,transparent 55%),url(\"https://images.unsplash.com/photo-1571266028243-d220c9c3b1c8?auto=format&fit=crop&w=1000&q=85\") center/cover;border:1px solid #ffffff20}.float-card{position:absolute;bottom:22px;left:-20px;background:#1b1424ed;border:1px solid #ffffff25;border-radius:10px;padding:15px 18px}.float-card b,.float-card small{display:block}.float-card b{font-size:12px}.float-card small{color:#aaa1b5;font-size:10px;margin-top:5px}.section-head{display:flex;align-items:end;justify-content:space-between;margin-bottom:20px}.section-head h2,.organizer h2{font:700 34px \"Space Grotesk\";margin:8px 0}.filters{display:flex;gap:9px;flex-wrap:wrap;margin-bottom:22px}.chip{background:#171321;color:#c7becf;border:1px solid #ffffff16}.chip.selected,.chip:hover{background:#351344;border-color:#a51aff;color:white}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:17px;min-height:80px}.event{background:#171321;border:1px solid #ffffff14;border-radius:13px;overflow:hidden;cursor:pointer;transition:.2s}.event:hover{transform:translateY(-4px);border-color:#9e36d1}.cover{height:180px;background-size:cover;background-position:center;position:relative}.tag{position:absolute;top:12px;left:12px;background:#971be0;border-radius:5px;padding:6px 8px;font-size:9px;font-weight:800}.event-body{padding:15px}.event h3{font:700 19px \"Space Grotesk\";margin:0 0 12px}.event p{font-size:11px;color:#a9a0b3;margin:7px 0}.event-foot{display:flex;justify-content:space-between;border-top:1px solid #ffffff14;margin-top:13px;padding-top:12px;font-size:12px}.price{color:#ff9b39;font-weight:800}.muted{color:#9d94a8;font-size:12px}.center{text-align:center;padding:30px}.organizer{margin-top:85px;margin-bottom:75px;padding:40px 48px;border:1px solid #ffffff18;border-radius:18px;background:radial-gradient(circle at 80% 50%,#6b13852e,transparent 35%),#171020;display:flex;align-items:center;justify-content:space-between}.organizer h2{font-size:38px}.organizer p{font-size:13px}.orb{width:175px;height:175px;border:1px solid #a832d5;border-radius:50%;display:grid;place-items:center;font:700 48px \"Space Grotesk\";box-shadow:0 0 55px #8c00ff25}.orb sup{color:var(--orange);font-size:18px}.footer{border-top:1px solid #ffffff16;padding:25px 0 35px;display:flex;justify-content:space-between;align-items:center;color:#82798d;font-size:11px}.overlay{position:fixed;inset:0;background:#05030bdc;z-index:10;display:grid;place-items:center;padding:16px}.dialog{width:min(510px,100%);max-height:90vh;overflow:auto;background:#181321;border:1px solid #55386a;border-radius:16px;padding:28px;position:relative}.close{position:absolute;right:15px;top:9px;background:none;border:0;color:white;font-size:27px;cursor:pointer}.dialog h2{font:700 26px \"Space Grotesk\";margin:8px 0}.dialog p{color:#b4abba;font-size:12px;line-height:1.6}.dialog label{display:block;color:#c9bfd2;font-size:11px;margin:13px 0}.dialog input,.dialog select,.dialog textarea{width:100%;display:block;margin-top:6px;padding:12px;border-radius:8px;border:1px solid #493b53;background:#0d0a13;color:#fff;outline:0}.dialog textarea{min-height:90px;resize:vertical}.dialog .primary{width:100%;margin-top:12px}.toast{position:fixed;bottom:22px;left:50%;transform:translate(-50%,20px);opacity:0;background:#2b1937;border:1px solid #754397;border-radius:9px;padding:12px 17px;font-size:12px;z-index:20;transition:.2s;max-width:90%;text-align:center}.toast.show{opacity:1;transform:translate(-50%,0)}.ticket{padding:15px;border:1px dashed #a14bc8;border-radius:10px;margin:12px 0;background:#100c18}.ticket strong{display:block;font-size:15px}.ticket small{color:#b4abba}.hidden{display:none}@media(max-width:800px){nav{display:none}.mobile-menu{display:block}.hero{grid-template-columns:1fr;padding-top:50px}.hero-art{height:270px}.grid{grid-template-columns:repeat(2,1fr)}.top-actions .ghost:first-child{display:none}}@media(max-width:560px){.top{padding:0 15px}.top-actions{margin-left:auto;margin-right:8px}.top-actions button{padding:9px;font-size:10px}.mobile-menu{display:block}.hero h1{font-size:58px}.search{flex-wrap:wrap}.search input{flex-basis:100%;padding:12px}.search select,.search button{flex:1}.proof{gap:9px;flex-wrap:wrap}.grid{grid-template-columns:1fr}.organizer{padding:27px 22px}.organizer h2{font-size:29px}.orb{display:none}.footer .brand small{display:none}}\n.menu-links{display:grid;gap:10px;margin-top:14px}.menu-links a{padding:13px 15px;border:1px solid #493b53;border-radius:8px;font-size:13px;font-weight:700}.menu-links .ghost,.menu-links .primary{width:100%}\n", "text/css; charset=utf-8"], "/": ["<!doctype html>\n<html lang=\"en\"><head>\n<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<meta name=\"theme-color\" content=\"#09070f\"><title>Active Tonight — Find Your Vibe. Own Your Night.</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\"><link href=\"https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&display=swap\" rel=\"stylesheet\">\n<link rel=\"stylesheet\" href=\"styles.css\"><script src=\"https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2\"></script>\n</head><body>\n<header class=\"top\"><a class=\"brand\" href=\"#\"><span class=\"mark\">✦</span><span>ACTIVE <b>TONIGHT</b><small>FIND YOUR VIBE. OWN YOUR NIGHT.</small></span></a>\n<nav><a href=\"#discover\">Discover</a><a href=\"#organizer\">For organizers</a></nav>\n<div class=\"top-actions\"><button class=\"ghost\" id=\"myTickets\">My tickets</button><button class=\"ghost\" id=\"login\">Log in</button><button class=\"primary\" id=\"signup\">Join Active Tonight ↗</button></div><button class=\"mobile-menu\" id=\"mobileMenu\">☰</button></header>\n<main>\n<section class=\"hero wrap\"><div><div class=\"eyebrow\">YOUR CITY. YOUR NIGHT. YOUR SCENE.</div><h1>Make tonight<br><span>unforgettable.</span></h1><p>Discover the best parties, concerts, lounges and experiences happening around you.</p>\n<div class=\"search\"><input id=\"query\" placeholder=\"Search events, venues or artists\"><select id=\"city\"><option value=\"\">All cities</option><option>Lagos</option><option>Warri</option><option>Asaba</option><option>Abraka</option><option>Benin City</option><option>Abuja</option><option>Port Harcourt</option></select><button class=\"primary\" id=\"search\">Explore events</button></div>\n<div class=\"proof\"><span>✦ Curated experiences</span><span>◉ Across Nigeria</span><span>✓ Secure ticketing</span></div></div><div class=\"hero-art\"><div class=\"hero-photo\"></div><div class=\"float-card\"><b>THE NIGHT IS YOURS</b><small>Find what's happening near you.</small></div></div></section>\n<section class=\"wrap\" id=\"discover\"><div class=\"section-head\"><div><div class=\"eyebrow\">FIND YOUR VIBE</div><h2>Explore events</h2></div><select id=\"sort\"><option value=\"soon\">Soonest first</option><option value=\"popular\">Popular first</option></select></div>\n<div class=\"filters\" id=\"categories\"><button class=\"chip selected\" data-cat=\"\">All events</button><button class=\"chip\" data-cat=\"Nightclubs\">Nightclubs</button><button class=\"chip\" data-cat=\"Concerts\">Concerts</button><button class=\"chip\" data-cat=\"Parties\">Parties</button><button class=\"chip\" data-cat=\"Lounges\">Lounges</button><button class=\"chip\" data-cat=\"Festivals\">Festivals</button></div>\n<div id=\"events\" class=\"grid\"><p class=\"muted\">Loading events…</p></div><p class=\"muted center\" id=\"empty\" hidden>No events match those filters yet.</p></section>\n<section class=\"organizer wrap\" id=\"organizer\"><div><div class=\"eyebrow\">FOR EVENT ORGANIZERS</div><h2>Your event deserves<br><span>a bigger crowd.</span></h2><p>Create an organizer account, submit your event and reach people looking for their next great night out.</p><button class=\"primary\" id=\"createEvent\">List your event ↗</button></div><div class=\"orb\">AT<sup>✦</sup></div></section>\n</main>\n<footer class=\"wrap footer\"><a class=\"brand\" href=\"#\"><span class=\"mark\">✦</span><span>ACTIVE <b>TONIGHT</b><small>FIND YOUR VIBE. OWN YOUR NIGHT.</small></span></a><span>© <span id=\"year\"></span> Active Tonight</span></footer>\n<div class=\"overlay\" id=\"modal\" hidden><section class=\"dialog\"><button class=\"close\" id=\"close\">×</button><div id=\"modalContent\"></div></section></div><div id=\"toast\" class=\"toast\"></div>\n<script src=\"app.js\"></script></body></html>", "text/html; charset=utf-8"]};
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
};
const API = {
  "/api/korapay-initialize": { POST: handleInitialize },
  "/api/korapay-verify": { GET: handleVerify },
  "/api/korapay-webhook": { POST: handleWebhook },
};

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
      const route = API[path];
      if (!route) return new Response("Not found", { status: 404 });
      const handler = route[request.method];
      if (!handler) return new Response("Method not allowed", { status: 405 });
      return handler({ request, env });
    }
    const file = SITE[path];
    if (!file || !["GET", "HEAD"].includes(request.method)) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : file[0], {
      headers: { "Content-Type": file[1], "Cache-Control": "public, max-age=0, must-revalidate", ...SECURITY_HEADERS },
    });
  },
};
