# Custom domains — server setup

Creators connect their own domain from **Dashboard → Domain** (`views/domain.ejs`,
`lib/customDomains.js`). The app does the DNS check and routing; HTTPS
certificates come from **Caddy**, which replaces nginx on ports 80/443.

## One-time setup on the VPS

1. **Install Caddy** (Ubuntu/Debian):
   ```sh
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install caddy
   ```
2. **Copy the config**: `sudo cp deploy/Caddyfile /etc/caddy/Caddyfile`, then edit the
   `email` line (Let's Encrypt sends expiry notices there) and the port if the app
   isn't on 3001.
3. **Swap nginx for Caddy** (both want ports 80/443):
   ```sh
   sudo systemctl stop nginx && sudo systemctl disable nginx
   sudo systemctl restart caddy
   ```
   pagezaper.com gets its certificate within a minute. Check with
   `sudo journalctl -u caddy -f`. To go back: stop caddy, start nginx.
4. **Set the server's IP** in the app's `.env` (shown to creators in the DNS table and
   used to check their A record): `SERVER_IP=203.0.113.10`, then restart the app.
   Without it the app uses whatever pagezaper.com resolves to — fine unless
   pagezaper.com is behind a proxy like Cloudflare.
5. **Firewall**: ports 80 and 443 open (Let's Encrypt needs 80 for some checks).

## How a creator connects a domain

1. Dashboard → Domain → type `mybrand.com` → Connect.
2. At their registrar: `A @ → SERVER_IP` and `CNAME www → pagezaper.com`
   (a subdomain like `shop.mybrand.com`: one `CNAME shop → pagezaper.com`).
3. Verify. Status goes **Waiting for DNS → Waiting for HTTPS → Live**. The HTTPS
   step is the app visiting `https://mybrand.com/.well-known/pagezaper-domain`, which
   makes Caddy issue the certificate.
4. Once **Live**, the store's links use `https://mybrand.com`, and the root opens the
   page they picked (store, course, event, booking page or payment page).

## Testing locally

No DNS or Caddy needed: connect a domain ending in `.localhost` with two labels
before it, e.g. `shop.mybrand.localhost` — it's live straight away and opens at
`http://shop.mybrand.localhost:3000`.
