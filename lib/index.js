'use strict'

const uriTemplates = require('uri-templates')
const inflection = require('inflection')

const settings = require('./settings')
const mediaType = settings.mediaType
const reservedKeys = settings.reservedKeys
const defaults = settings.defaults

const pageLimit = settings.pageLimit
const pageOffset = settings.pageOffset
const encodedLimit = encodeURIComponent(pageLimit)
const encodedOffset = encodeURIComponent(pageOffset)

const helpers = require('./helpers')
const mapRecord = helpers.mapRecord
const matchId = helpers.matchId
const mapId = helpers.mapId
const castId = helpers.castId
const initializeContext = helpers.initializeContext
const under = helpers.under
const parseBuffer = helpers.parseBuffer


// JSON API is an highly verbose and ambiguous specification. There are many
// trade-offs made in an attempt to cover everyone's use cases, such as
// resource identifier objects for polymorphic link fields, and relationship
// entities which are an entirely unnecessary complication. More importantly,
// it assumes tight coupling with the API consumer and the HTTP protocol. For
// example, it assumes that the client has *a priori* knowledge of types that
// exist on the server, since it does not define an entry point.
//
// The format is painful to implement and the specification is pretty long,
// I would not recommend doing it yourself unless you're a masochist like me.


module.exports = Serializer => Object.assign(
class JsonApiSerializer extends Serializer {

  constructor (dependencies) {
    super(dependencies)

    const options = this.options
    const methods = this.methods

    const methodMap = {
      GET: methods.find,
      POST: methods.create,
      PATCH: methods.update,
      DELETE: methods.delete
    }

    // Set options.
    for (const key in defaults)
      if (!(key in options))
        options[key] = defaults[key]

    const uriTemplate = uriTemplates((options ?
      options.uriTemplate : null) || defaults.uriTemplate)

    Object.defineProperties(this, {

      // Parse the URI template.
      uriTemplate: { value: uriTemplate },

      // Default method mapping.
      methodMap: { value: methodMap }
    })
  }


  processRequest (contextRequest, request, response) {
    return initializeContext.call(this, contextRequest, request, response)
  }


  processResponse (contextResponse, request, response) {
    const options = this.options
    const jsonSpaces = options.jsonSpaces
    const bufferEncoding = options.bufferEncoding
    let payload = contextResponse.payload

    if (!contextResponse.meta) contextResponse.meta = {}
    if (!contextResponse.meta.headers) contextResponse.meta.headers = {}
    if (payload && payload.records)
      contextResponse = this.showResponse(contextResponse,
        request, payload.records, payload.include)
    if (contextResponse instanceof Error) {
      if (contextResponse.isMethodInvalid) return contextResponse
      if (contextResponse.isTypeUnspecified)
        this.showIndex(contextResponse, request, response)
      else this.showError(contextResponse)
    }

    payload = contextResponse.payload
    if (!payload) return contextResponse

    contextResponse.payload = JSON.stringify(payload, (key, value) => {
      // Duck type checking for buffer stringification.
      if (value && value.type === 'Buffer' &&
        Array.isArray(value.data) &&
        Object.keys(value).length === 2)
        return new Buffer(value.data).toString(bufferEncoding)

      return value
    }, jsonSpaces)

    return contextResponse
  }


  showIndex (contextResponse, request, response) {
    const recordTypes = this.recordTypes
    const uriTemplate = this.uriTemplate
    const options = this.options
    const inflectType = options.inflectType
    const prefix = options.prefix

    contextResponse.payload = { [reservedKeys.links]: {} }

    for (let type in recordTypes) {
      if (inflectType) type = inflection.pluralize(type)
      contextResponse.payload[reservedKeys.links][type] = prefix +
        uriTemplate.fillFromObject({ type })
    }
    response.statusCode = 200
  }


  showResponse (contextResponse, request, records, include) {
    const keys = this.keys
    const methods = this.methods
    const uriTemplate = this.uriTemplate
    const recordTypes = this.recordTypes
    const options = this.options
    const prefix = options.prefix
    const inflectType = options.inflectType
    const inflectKeys = options.inflectKeys
    const NotFoundError = this.errors.NotFoundError

    const meta = request.meta
    const method = meta.method
    const type = meta.type
    const ids = meta.ids
    const relatedField = meta.relatedField
    const relationship = meta.relationship
    const originalType = meta.originalType
    const originalIds = meta.originalIds
    const updateModified = contextResponse.meta.updateModified

    if (relationship)
      return this.showRelationship(contextResponse, request, records)

    // Handle a not found error.
    if (ids && ids.length && method === methods.find &&
      !relatedField && !records.length)
      return new NotFoundError('No records match the request.')

    // Delete and update requests may not respond with anything.
    if (method === methods.delete ||
    (method === methods.update && !updateModified)) {
      delete contextResponse.payload
      return contextResponse
    }

    const output = {}

    // Show collection.
    if (!ids && method === methods.find) {
      const count = records.count
      const query = meta.uriObject.query
      const limit = meta.options.limit
      const offset = meta.options.offset
      const collection = prefix + uriTemplate.fillFromObject({ query,
        type: inflectType ? inflection.pluralize(type) : type })


      output[reservedKeys.meta] = { count }
      output[reservedKeys.links] = {
        [reservedKeys.self]: collection
      }
      output[reservedKeys.primary] = []
      // Set top-level pagination links.
      if (count > limit) {
        let queryLength = 0

        if (query) {
          delete query[pageOffset]
          delete query[pageLimit]
          queryLength = Object.keys(query).length
        }

        const paged = prefix + uriTemplate.fillFromObject({
          query, type: inflectType ? inflection.pluralize(type) : type
        })

        Object.assign(output[reservedKeys.links], {
          [reservedKeys.first]: `${paged}${queryLength ? '&' : '?'}` +
            `${encodedOffset}=0` +
            `&${encodeURIComponent(pageLimit)}=${limit}`,
          [reservedKeys.last]: `${paged}${queryLength ? '&' : '?'}` +
            `${encodedOffset}=${Math.floor((count - 1) / limit) * limit}` +
            `&${encodedLimit}=${limit}`
        },
        limit + (offset || 0) < count ? {
          [reservedKeys.next]: `${paged}${queryLength ? '&' : '?'}` +
            `${encodedOffset}=${(Math.floor((offset || 0) / limit) + 1) *
              limit}&${encodedLimit}=${limit}`
        } : null,
        (offset || 0) >= limit ? {
          [reservedKeys.prev]: `${paged}${queryLength ? '&' : '?'}` +
            `${encodedOffset}=${(Math.floor((offset || 0) / limit) - 1) *
              limit}&${encodedLimit}=${limit}`
        } : null)
      }
    }

    if (records.length) {
      if (ids)
        output[reservedKeys.links] = {
          [reservedKeys.self]: prefix + uriTemplate.fillFromObject({
            type: inflectType ? inflection.pluralize(type) : type,
            ids
          })
        }

      output[reservedKeys.primary] = records.map(record =>
        mapRecord.call(this, type, record))

      if ((!originalType || (originalType &&
        !recordTypes[originalType][relatedField][keys.isArray])) &&
        ((ids && ids.length === 1) ||
        (method === methods.create && records.length === 1)))
        output[reservedKeys.primary] = output[reservedKeys.primary][0]

      if (method === methods.create)
        contextResponse.meta.headers['Location'] = prefix +
          uriTemplate.fillFromObject({
            type: inflectType ? inflection.pluralize(type) : type,
            ids: records.map(record => record[keys.primary])
          })
    }
    else if (relatedField)
      output[reservedKeys.primary] =
    recordTypes[originalType][relatedField][keys.isArray] ? [] : null

    // Set related records.
    if (relatedField)
      output[reservedKeys.links] = {
        [reservedKeys.self]: prefix + uriTemplate.fillFromObject({
          type: inflectType ?
            inflection.pluralize(originalType) : originalType,
          ids: originalIds,
          relatedField: inflectKeys ? inflection.transform(relatedField,
            [ 'underscore', 'dasherize' ]) : relatedField
        })
      }

    // To show included records, we have to flatten them :(
    if (include) {
      output[reservedKeys.included] = []

      for (const type of Object.keys(include))
        Array.prototype.push.apply(output[reservedKeys.included],
          include[type].map(mapRecord.bind(this, type)))
    }

    if (Object.keys(output).length)
      contextResponse.payload = output

    return contextResponse
  }


  showRelationship (contextResponse, request, records) {
    const meta = request.meta
    const method = meta.method
    const type = meta.type
    const relatedField = meta.relatedField
    const originalType = meta.originalType
    const originalIds = meta.originalIds

    const keys = this.keys
    const uriTemplate = this.uriTemplate
    const recordTypes = this.recordTypes
    const methods = this.methods
    const options = this.options
    const prefix = options.prefix
    const inflectType = options.inflectType
    const inflectKeys = options.inflectKeys
    const BadRequestError = this.errors.BadRequestError

    if (originalIds.length > 1)
      throw new BadRequestError(
        'Can only show relationships for one record at a time.')

    if (method !== methods.find) {
      delete contextResponse.payload
      return contextResponse
    }

    const output = {
      [reservedKeys.links]: {
        [reservedKeys.self]: prefix + uriTemplate.fillFromObject({
          type: inflectType ?
            inflection.pluralize(originalType) : originalType,
          ids: originalIds, relatedField: reservedKeys.relationships,
          relationship: inflectKeys ? inflection.transform(relatedField,
              [ 'underscore', 'dasherize' ]) : relatedField
        }),
        [reservedKeys.related]: prefix + uriTemplate.fillFromObject({
          type: inflectType ?
            inflection.pluralize(originalType) : originalType,
          ids: originalIds,
          relatedField: inflectKeys ? inflection.transform(relatedField,
            [ 'underscore', 'dasherize' ]) : relatedField
        })
      }
    }

    const isArray = recordTypes[originalType][relatedField][keys.isArray]
    const identifiers = records.map(record => ({
      [reservedKeys.type]: inflectType ?
        inflection.pluralize(type) : type,
      [reservedKeys.id]: record[keys.primary]
    }))

    output[reservedKeys.primary] = isArray ? identifiers :
      identifiers.length ? identifiers[0] : null

    contextResponse.payload = output

    return contextResponse
  }


  parsePayload (contextRequest) {
    const methods = this.methods
    const method = contextRequest.method

    if (method === methods.create) return this.parseCreate(contextRequest)
    else if (method === methods.update) return this.parseUpdate(contextRequest)

    throw new Error('Method is invalid.')
  }


  parseCreate (contextRequest) {
    contextRequest.payload = parseBuffer.call(this, contextRequest.payload)
    const keys = this.keys
    const recordTypes = this.recordTypes
    const castValue = this.castValue
    const options = this.options
    const inflectType = options.inflectType
    const inflectKeys = options.inflectKeys
    const errors = this.errors
    const MethodError = errors.MethodError
    const BadRequestError = errors.BadRequestError
    const ConflictError = errors.ConflictError

    const payload = contextRequest.payload
    const relatedField = contextRequest.relatedField
    const type = contextRequest.type
    const ids = contextRequest.ids

    const fields = recordTypes[type]
    const cast = (type, options) => value => castValue(value, type, options)

    // Can not create with IDs specified in route.
    if (ids)
      throw new MethodError('Can not create with ID in the route.')

    // Can not create if related records are specified.
    if (relatedField)
      throw new MethodError('Can not create related record.')

    let data = payload[reservedKeys.primary]

    // No bulk extension for now.
    if (Array.isArray(data))
      throw new BadRequestError('Data must be singular.')

    data = [ data ]

    return data.map(record => {
      if (!(reservedKeys.type in record))
        throw new BadRequestError(
          `The required field "${reservedKeys.type}" is missing.`)

      const clone = {}
      const recordType = inflectType ?
        inflection.singularize(record[reservedKeys.type]) :
        record[reservedKeys.type]

      if (recordType !== type)
        throw new ConflictError('Incorrect type.')

      if (reservedKeys.id in record)
        clone[reservedKeys.id] = castId(record[reservedKeys.id])

      if (reservedKeys.attributes in record)
        for (let field in record[reservedKeys.attributes]) {
          const value = record[reservedKeys.attributes][field]

          if (inflectKeys) field = inflection.camelize(under(field), true)

          const fieldDefinition = fields[field] || {}
          const fieldType = fieldDefinition[keys.type]

          clone[field] = Array.isArray(value) ?
            value.map(cast(fieldType, options)) :
            castValue(value, fieldType, options)
        }

      if (reservedKeys.relationships in record)
        for (let field of Object.keys(record[reservedKeys.relationships])) {
          const value = record[reservedKeys.relationships][field]

          if (inflectKeys) field = inflection.camelize(under(field), true)

          if (!(reservedKeys.primary in value))
            throw new BadRequestError('The ' +
              `"${reservedKeys.primary}" field is missing.`)

          const relatedType = inflectType ?
            inflection.pluralize(fields[field][keys.link]) :
            fields[field][keys.link]
          const relatedIsArray = fields[field][keys.isArray]
          const data = value[reservedKeys.primary]

          clone[field] = data ? (Array.isArray(data) ? data : [ data ])
            .map(mapId.bind(this, relatedType)) : null

          if (clone[field] && !relatedIsArray)
            clone[field] = clone[field][0]
        }

      return clone
    })
  }


  parseUpdate (contextRequest) {
    contextRequest.payload = parseBuffer.call(this, contextRequest.payload)

    const recordTypes = this.recordTypes
    const keys = this.keys
    const castValue = this.castValue

    const options = this.options
    const inflectType = options.inflectType
    const inflectKeys = options.inflectKeys

    const errors = this.errors
    const MethodError = errors.MethodError
    const BadRequestError = errors.BadRequestError
    const ConflictError = errors.ConflictError

    const payload = contextRequest.payload
    const type = contextRequest.type
    const ids = contextRequest.ids
    const relatedField = contextRequest.relatedField
    const relationship = contextRequest.relationship

    const cast = (type, options) => value => castValue(value, type, options)

    if (relationship) return this.updateRelationship(contextRequest)

    // No related record update.
    if (relatedField) throw new MethodError(
      'Can not update related record indirectly.')

    // Can't update collections.
    if (!Array.isArray(ids) || !ids.length)
      throw new BadRequestError('IDs unspecified.')

    const fields = recordTypes[type]
    const updates = []
    let data = payload[reservedKeys.primary]

    // No bulk/patch extension for now.
    if (Array.isArray(data))
      throw new BadRequestError('Data must be singular.')

    data = [ data ]

    for (const update of data) {
      const replace = {}
      const updateType = inflectType ?
        inflection.singularize(update[reservedKeys.type]) :
        update[reservedKeys.type]

      if (!ids.some(matchId.bind(null, update)))
        throw new ConflictError('Invalid ID.')

      if (updateType !== type)
        throw new ConflictError('Incorrect type.')

      if (reservedKeys.attributes in update)
        for (let field in update[reservedKeys.attributes]) {
          const value = update[reservedKeys.attributes][field]

          if (inflectKeys) field = inflection.camelize(under(field), true)

          const fieldDefinition = fields[field] || {}
          const fieldType = fieldDefinition[keys.type]

          replace[field] = Array.isArray(value) ?
            value.map(cast(fieldType, options)) :
            castValue(value, fieldType, options)
        }

      if (reservedKeys.relationships in update)
        for (let field of Object.keys(update[reservedKeys.relationships])) {
          const value = update[reservedKeys.relationships][field]

          if (inflectKeys) field = inflection.camelize(under(field), true)

          if (!(reservedKeys.primary in value))
            throw new BadRequestError(
              `The "${reservedKeys.primary}" field is missing.`)

          const relatedType = inflectType ?
            inflection.pluralize(fields[field][keys.link]) :
            fields[field][keys.link]
          const relatedIsArray = fields[field][keys.isArray]
          const data = value[reservedKeys.primary]

          replace[field] = data ? (Array.isArray(data) ? data : [ data ])
            .map(mapId.bind(this, relatedType)) : null

          if (replace[field] && !relatedIsArray)
            replace[field] = replace[field][0]
        }

      updates.push({
        id: castId(update[reservedKeys.id]),
        replace
      })
    }

    if (updates.length < ids.length)
      throw new BadRequestError('An update is missing.')

    return updates
  }


  updateRelationship (contextRequest) {
    const recordTypes = this.recordTypes
    const keys = this.keys
    const methods = this.methods
    const options = this.options
    const inflectType = options.inflectType

    const errors = this.errors
    const NotFoundError = errors.NotFoundError
    const MethodError = errors.MethodError
    const BadRequestError = errors.BadRequestError
    const ConflictError = errors.ConflictError

    const payload = contextRequest.payload
    const type = contextRequest.type
    const relatedField = contextRequest.relatedField
    const originalMethod = contextRequest.originalMethod
    const originalType = contextRequest.originalType
    const originalIds = contextRequest.originalIds

    const isArray = recordTypes[originalType][relatedField][keys.isArray]

    if (originalIds.length > 1)
      throw new NotFoundError(
        'Can only update relationships for one record at a time.')

    if (!isArray && originalMethod)
      throw new MethodError('Can not ' +
        `${originalMethod === methods.create ? 'push to' : 'pull from'}` +
        ' a to-one relationship.')

    const updates = []
    const operation = originalMethod ? originalMethod === methods.create ?
      'push' : 'pull' : 'replace'
    let updateIds = payload[reservedKeys.primary]

    if (!isArray)
      if (!Array.isArray(updateIds)) updateIds = [ updateIds ]
      else throw new BadRequestError('Data must be singular.')

    updateIds = updateIds.map(update => {
      const updateType = inflectType ?
        inflection.singularize(update[reservedKeys.type]) :
        update[reservedKeys.type]

      if (updateType !== type)
        throw new ConflictError('Incorrect type.')

      if (!(reservedKeys.id in update))
        throw new BadRequestError('ID is unspecified.')

      return castId(update[reservedKeys.id])
    })

    updates.push({
      id: originalIds[0],
      [operation]: {
        [relatedField]: isArray ? updateIds : updateIds[0]
      }
    })

    // Rewrite type and IDs.
    contextRequest.type = originalType
    contextRequest.ids = null

    return updates
  }


  showError (error) {
    const title = error.name
    const detail = error.message

    error.payload = {
      [reservedKeys.errors]: [
        Object.assign({ title, detail }, error)
      ]
    }
  }

}, { mediaType })
