'use strict'

const inflection = require('inflection')
const deepEqual = require('deep-equal')

const settings = require('./settings')
const reservedKeys = settings.reservedKeys
const inBrackets = settings.inBrackets
const isField = settings.isField
const isFilter = settings.isFilter
const mediaType = settings.mediaType
const pageOffset = settings.pageOffset
const pageLimit = settings.pageLimit


module.exports = {
  initializeContext, mapRecord, mapId, matchId, castId, under, parseBuffer
}


function initializeContext (contextRequest, request, response) {
  const uriTemplate = this.uriTemplate
  const methodMap = this.methodMap
  const recordTypes = this.recordTypes
  const adapter = this.adapter
  const keys = this.keys
  const methods = this.methods

  const options = this.options
  const inflectType = options.inflectType
  const inflectKeys = options.inflectKeys
  const prefix = options.prefix
  const allowLevel = options.allowLevel

  const errors = this.errors
  const NotAcceptableError = errors.NotAcceptableError
  const NotFoundError = errors.NotFoundError

  // According to the spec, if the media type is provided in the Accept
  // header, it should be included at least once without any media type
  // parameters.
  if (request.headers['accept'] &&
    ~request.headers['accept'].indexOf(mediaType)) {
    const escapedMediaType = mediaType.replace(/[\+\.]/g, '\\$&')
    const mediaTypeRegex = new RegExp(`${escapedMediaType}(?!;)`, 'g')
    if (!request.headers['accept'].match(mediaTypeRegex))
      throw new NotAcceptableError('The "Accept" header should contain' +
        'at least one instance of the JSON media type without any' +
        'media type parameters.')
  }

  request.meta = {}

  const meta = contextRequest.meta

  const method = contextRequest.method = request.meta.method =
    methodMap[request.method]

  // Decode URI Component only for the query string.
  const uriObject = contextRequest.uriObject = request.meta.uriObject =
    uriTemplate.fromUri(request.url)

  if (!Object.keys(uriObject).length && request.url.length > 1)
    throw new NotFoundError('Invalid URI.')

  const type = contextRequest.type = request.meta.type =
    uriObject.type ? inflectType ?
      inflection.singularize(uriObject.type) : uriObject.type : null

  // Show allow options.
  if ((!type || type in recordTypes) && !method) {
    delete uriObject.query
    const output = {
      meta: {
        headers: {
          'Allow': allowLevel[Object.keys(uriObject)
            .filter(key => uriObject[key]).length].join(', ')
        }
      }
    }
    response.statusCode = 204
    throw output
  }

  // Show the index route.
  if (!type && method === methods.find) {
    const output = { payload: { [reservedKeys.links]: {} } }

    for (let type in recordTypes) {
      if (inflectType) type = inflection.pluralize(type)
      output.payload[reservedKeys.links][type] = prefix +
        uriTemplate.fillFromObject({ type })
    }

    response.statusCode = 200
    throw output
  }

  const ids = contextRequest.ids = request.meta.ids =
    uriObject.ids ? (Array.isArray(uriObject.ids) ?
      uriObject.ids : [ uriObject.ids ]).map(castId) : null

  const fields = recordTypes[type]

  attachQueries.call(this, contextRequest)
  request.meta.options = contextRequest.options

  let relatedField = uriObject.relatedField
  const relationship = uriObject.relationship

  if (relationship) {
    if (relatedField !== reservedKeys.relationships)
      throw new NotFoundError('Invalid relationship URI.')

    // This is a little unorthodox, but POST and DELETE requests to a
    // relationship entity should be treated as updates.
    if (method === methods.create || method === methods.delete) {
      contextRequest.originalMethod = method
      contextRequest.method = methods.update
    }

    relatedField = relationship
  }

  if (relatedField && inflectKeys)
    relatedField = inflection.camelize(under(relatedField), true)

  if (relatedField && (!(relatedField in fields) ||
    !(keys.link in fields[relatedField]) ||
    fields[relatedField][keys.denormalizedInverse]))
    throw new NotFoundError(`The field "${relatedField}" is ` +
      `not a link on the type "${type}".`)

  return relatedField ? adapter.find(type, ids, {
    // We only care about getting the related field.
    fields: { [relatedField]: true }
  }, meta)
  .then(records => {
    // Reduce the related IDs from all of the records into an array of
    // unique IDs.
    const relatedIds = Array.from((records || []).reduce((ids, record) => {
      const value = record[relatedField]

      if (Array.isArray(value)) for (let id of value) ids.add(id)
      else ids.add(value)

      return ids
    }, new Set()))

    const relatedType = fields[relatedField][keys.link]

    // Copy the original type and IDs to temporary keys.
    contextRequest.relatedField = request.meta.relatedField = relatedField
    contextRequest.relationship = request.meta.relationship = relationship
    contextRequest.originalType = request.meta.originalType = type
    contextRequest.originalIds = request.meta.originalIds = ids

    // Write the related info to the request, which should take
    // precedence over the original type and IDs.
    contextRequest.type = request.meta.type = relatedType
    contextRequest.ids = request.meta.ids = relatedIds

    return contextRequest
  }) : contextRequest
}


/**
 * Internal function to map a record to JSON API format. It must be
 * called directly within the context of the serializer. Within this
 * function, IDs must be cast to strings, per the spec.
 */
function mapRecord (type, record) {
  const keys = this.keys
  const uriTemplate = this.uriTemplate
  const recordTypes = this.recordTypes
  const fields = recordTypes[type]
  const options = this.options
  const prefix = options.prefix
  const inflectType = options.inflectType
  const inflectKeys = options.inflectKeys
  const clone = {}

  const id = record[keys.primary]

  clone[reservedKeys.type] = inflectType ? inflection.pluralize(type) : type
  clone[reservedKeys.id] = id.toString()
  clone[reservedKeys.meta] = {}
  clone[reservedKeys.attributes] = {}
  clone[reservedKeys.relationships] = {}
  clone[reservedKeys.links] = {
    [reservedKeys.self]: prefix + uriTemplate.fillFromObject({
      type: inflectType ? inflection.pluralize(type) : type,
      ids: id
    })
  }

  for (let field in record) {
    if (field === keys.primary) continue

    const fieldDefinition = fields[field]
    const originalField = field

    // Per the recommendation, dasherize keys.
    if (inflectKeys)
      field = inflection.transform(field,
        [ 'underscore', 'dasherize' ])

    // Handle meta/attributes.
    if (!fieldDefinition || fieldDefinition[keys.type]) {
      const value = record[originalField]

      if (!fieldDefinition) clone[reservedKeys.meta][field] = value
      else clone[reservedKeys.attributes][field] = value

      continue
    }

    // Handle link fields.
    const ids = record[originalField]

    const linkedType = inflectType ?
      inflection.pluralize(fieldDefinition[keys.link]) :
      fieldDefinition[keys.link]

    clone[reservedKeys.relationships][field] = {
      [reservedKeys.links]: {
        [reservedKeys.self]: prefix + uriTemplate.fillFromObject({
          type: inflectType ? inflection.pluralize(type) : type,
          ids: id,
          relatedField: reservedKeys.relationships,
          relationship: inflectKeys ? inflection.transform(field,
            [ 'underscore', 'dasherize' ]) : field
        }),
        [reservedKeys.related]: prefix + uriTemplate.fillFromObject({
          type: inflectType ? inflection.pluralize(type) : type,
          ids: id,
          relatedField: inflectKeys ? inflection.transform(field,
            [ 'underscore', 'dasherize' ]) : field
        })
      },
      [reservedKeys.primary]: fieldDefinition[keys.isArray] ?
        ids.map(toIdentifier.bind(null, linkedType)) :
        (ids ? toIdentifier(linkedType, ids) : null)
    }
  }

  if (!Object.keys(clone[reservedKeys.attributes]).length)
    delete clone[reservedKeys.attributes]

  if (!Object.keys(clone[reservedKeys.meta]).length)
    delete clone[reservedKeys.meta]

  if (!Object.keys(clone[reservedKeys.relationships]).length)
    delete clone[reservedKeys.relationships]

  return clone
}


function toIdentifier (type, id) {
  return {
    [reservedKeys.type]: type,
    [reservedKeys.id]: id.toString()
  }
}


function attachQueries (request) {
  const recordTypes = this.recordTypes
  const keys = this.keys
  const castValue = this.castValue
  const BadRequestError = this.errors.BadRequestError
  const options = this.options
  const includeLimit = options.includeLimit
  const maxLimit = options.maxLimit
  const type = request.type
  const fields = recordTypes[type]
  const reduceFields = (fields, field) => {
    fields[field] = true
    return fields
  }
  const castMap = (type, options, x) => castValue(x, type, options)

  let query = request.uriObject.query
  if (!query) query = {}
  request.options = {}

  // Iterate over dynamic query strings.
  for (let parameter of Object.keys(query)) {
    // Attach fields option.
    if (parameter.match(isField)) {
      const sparseField = query[parameter].split(',')
      const sparseType = (parameter.match(inBrackets) || [])[1]
      const fields = sparseField.reduce(reduceFields, {})

      if (sparseType === type)
        request.options.fields = fields
      else if (sparseType) {
        if (!(sparseType in request.includeOptions))
          request.includeOptions[sparseType] = {}

        request.includeOptions[sparseType].fields = fields
      }
    }

    // Attach match option.
    if (parameter.match(isFilter)) {
      if (!('match' in request.options)) request.options.match = {}
      const field = (parameter.match(inBrackets) || [])[1]

      if (!(field in fields)) throw new BadRequestError(
        `The field "${field}" is non-existent.`)

      const fieldType = fields[field][keys.type]
      const value = query[parameter].split(',')

      request.options.match[field] =
        value.map(castMap.bind(null, fieldType, options))
    }
  }

  // Attach include option.
  if (reservedKeys.include in query) {
    request.include = query[reservedKeys.include].split(',')
      .map(i => i.split('.').slice(0, includeLimit))

    // Manually expand nested includes.
    for (let path of request.include)
      for (let i = path.length - 1; i > 0; i--) {
        const j = path.slice(0, i)
        if (!request.include.some(deepEqual.bind(null, j)))
          request.include.push(j)
      }
  }

  // Attach sort option.
  if (reservedKeys.sort in query)
    request.options.sort = query.sort.split(',')
      .reduce((sort, field) => {
        if (field.charAt(0) === '-') sort[field.slice(1)] = false
        else sort[field] = true
        return sort
      }, {})

  // Attach offset option.
  if (pageOffset in query)
    request.options.offset = Math.abs(parseInt(query[pageOffset], 10))

  // Attach limit option.
  if (pageLimit in query)
    request.options.limit = Math.abs(parseInt(query[pageLimit], 10))

  // Check limit option.
  const limit = request.options.limit
  if (!limit || limit > maxLimit) request.options.limit = maxLimit
}


function mapId (relatedType, link) {
  const ConflictError = this.errors.ConflictError

  if (link[reservedKeys.type] !== relatedType)
    throw new ConflictError('Data object field ' +
      `"${reservedKeys.type}" is invalid, it must be ` +
      `"${relatedType}", not "${link[reservedKeys.type]}".`)

  return castId(link[reservedKeys.id])
}


function matchId (object, id) {
  return id === castId(object[reservedKeys.id])
}


function castId (id) {
  // Stolen from jQuery source code:
  // https://api.jquery.com/jQuery.isNumeric/
  const float = Number.parseFloat(id)
  return id - float + 1 >= 0 ? float : id
}


function under (s) {
  return s.replace(/-/g, '_')
}


function parseBuffer (payload) {
  const BadRequestError = this.errors.BadRequestError

  if (!Buffer.isBuffer(payload)) return payload

  try {
    return JSON.parse(payload.toString())
  }
  catch (error) {
    throw new BadRequestError(`Invalid JSON: ${error.message}`)
  }
}
