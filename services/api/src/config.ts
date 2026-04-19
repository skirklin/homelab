/**
 * Single source of truth for service URLs.
 *
 * Set DOMAIN=foo.com (or DOMAIN=beta.kirkl.in) and everything derives from it.
 * Individual URLs can still be overridden explicitly for special cases
 * (e.g. PB_URL=http://pocketbase:8090 inside k8s).
 */

export const DOMAIN = process.env.DOMAIN || "kirkl.in";

export const API_BASE = process.env.API_BASE || `https://api.${DOMAIN}/fn`;
export const PB_URL = process.env.PB_URL || `https://api.${DOMAIN}`;
export const RECIPES_BASE_URL = process.env.RECIPES_BASE_URL || `https://recipes.${DOMAIN}`;
export const TRAVEL_BASE_URL = process.env.TRAVEL_BASE_URL || `https://travel.${DOMAIN}`;
