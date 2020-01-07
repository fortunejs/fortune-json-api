'use strict'

// Reserved keys from the JSON API specification.
const reservedKeys = {
  // Top-level description.
  jsonapi: 'jsonapi',

  // Document structure.
  primary: 'data',
  attributes: 'attributes',
  relationships: 'relationships',
  type: 'type',
  id: 'id',
  meta: 'meta',
  errors: 'errors',
  included: 'included',

  // Hypertext.
  links: 'links',
  href: 'href',
  related: 'related',
  self: 'self',

  // Reserved query strings.
  include: 'include',
  fields: 'fields',
  filter: 'filter',
  sort: 'sort',
  page: 'page',

  // Pagination keys.
  first: 'first',
  last: 'last',
  prev: 'prev',
  next: 'next'
}

const defaults = {
  // Inflect the record type name in the URI. The expectation is that the
  // record type names are singular, so this will pluralize types.
  inflectType: true,

  // Inflect the names of the fields per record. The expectation is that the
  // keys are lower camel cased, and the output is dasherized.
  inflectKeys: true,

  // Maximum number of records to show per page.
  maxLimit: 1000,

  // Maximum number of fields per include.
  includeLimit: 3,

  // What encoding to use for input buffer fields.
  bufferEncoding: 'base64',

  // How many spaces to use for pretty printing JSON.
  jsonSpaces: 2,

  // Hyperlink prefix, without leading or trailing slashes.
  prefix: '',

  // Versioning information.
  jsonapi: {
    version: '1.0'
  },

  // Turn numeric string IDs into numbers.
  castNumericIds: true,

  // URI Template. See RFC 6570:
  // https://tools.ietf.org/html/rfc6570
  uriTemplate: '{/type,ids,relatedField,relationship}{?query*}',

  // What HTTP methods may be allowed, ordered by appearance in URI template.
  allowLevel: [
    [ 'GET' ], // Index
    [ 'GET', 'POST' ], // Collection
    [ 'GET', 'PATCH', 'DELETE' ], // Records
    [ 'GET' ], // Related
    [ 'GET', 'POST', 'PATCH', 'DELETE' ] // Relationship
  ]
}

module.exports = {
  reservedKeys, defaults,

  typeInflections: [
    [ 'singularize', 'camelize' ], // Input
    [ 'pluralize', 'underscore', 'dasherize' ] // Output
  ],

  // Registered media type.
  mediaType: 'application/vnd.api+json',

  // Regular expressions.
  inBrackets: /\[([^\]]+)\](?:\[([^\]]+)\])?/,
  isField: new RegExp(`^${reservedKeys.fields}`),
  isFilter: new RegExp(`^${reservedKeys.filter}`),
  pageLimit: `${reservedKeys.page}[limit]`,
  pageOffset: `${reservedKeys.page}[offset]`
}
