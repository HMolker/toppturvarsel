/**
 * The User-Agent for every outgoing request. Wikimedia (Commons and its
 * thumbnail servers) requires one that names the client and gives a way to
 * reach its maintainer, and refuses generic ones with 403; OpenStreetMap's
 * Overpass and MET Norway ask for the same. See
 * https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy
 */
export const UA = 'Fjallskred/4 (self-hosted ski touring dashboard; +https://github.com/HMolker/toppturvarsel)';
