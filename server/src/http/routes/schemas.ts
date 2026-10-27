// JSON schemas shared by the admin routes. Response schemas list exactly the
// fields that may leave the server (ASVS 5.0.0 V15.3.1); request schemas list
// exactly the writable fields and reject anything else (V15.3.3).

export const dateTime = { type: 'string', format: 'date-time' } as const
export const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const
export const positiveId = { type: 'integer', minimum: 1, maximum: 2_147_483_647 } as const
export const version = { type: 'integer', minimum: 1, maximum: 2_147_483_647 } as const
export const nameText = { type: 'string', minLength: 1, maxLength: 100 } as const
export const descriptionText = { type: 'string', maxLength: 500 } as const

export const idParams = {
  type: 'object',
  properties: { id: positiveId },
  required: ['id'],
  additionalProperties: false
} as const

const idAndName = {
  type: 'object',
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
  required: ['id', 'name'],
  additionalProperties: false
} as const

const userListItemProperties = {
  id: { type: 'integer' },
  username: { type: 'string' },
  displayName: { type: 'string' },
  jobTitle: { ...idAndName, type: ['object', 'null'] },
  status: { type: 'string', enum: ['active', 'disabled'] },
  isOwner: { type: 'boolean' },
  isAdministrator: { type: 'boolean' },
  hasPassword: { type: 'boolean' },
  lastLoginAt: nullableDateTime,
  createdAt: dateTime,
  version: { type: 'integer' }
} as const

const userListItemRequired = Object.keys(userListItemProperties)

export const userListItemSchema = {
  type: 'object',
  properties: userListItemProperties,
  required: userListItemRequired,
  additionalProperties: false
} as const

export const userDetailSchema = {
  type: 'object',
  properties: {
    ...userListItemProperties,
    liveSessions: { type: 'integer' },
    access: {
      type: 'object',
      properties: {
        systemProfiles: { type: 'array', items: idAndName },
        warehouseAssignments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              warehouseId: { type: 'integer' },
              warehouseCode: { type: 'string' },
              profileId: { type: 'integer' },
              profileName: { type: 'string' }
            },
            required: ['warehouseId', 'warehouseCode', 'profileId', 'profileName'],
            additionalProperties: false
          }
        }
      },
      required: ['systemProfiles', 'warehouseAssignments'],
      additionalProperties: false
    }
  },
  required: [...userListItemRequired, 'liveSessions', 'access'],
  additionalProperties: false
} as const

export const profileSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: 'string' },
    scope: { type: 'string', enum: ['system', 'warehouse'] },
    isActive: { type: 'boolean' },
    permissions: { type: 'array', items: { type: 'string' } },
    assignedUsers: { type: 'integer' },
    version: { type: 'integer' }
  },
  required: ['id', 'name', 'description', 'scope', 'isActive', 'permissions', 'assignedUsers', 'version'],
  additionalProperties: false
} as const

export const jobTitleSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: 'string' },
    isActive: { type: 'boolean' },
    version: { type: 'integer' }
  },
  required: ['id', 'name', 'description', 'isActive', 'version'],
  additionalProperties: false
} as const

export const warehouseSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    code: { type: 'string' },
    name: { type: 'string' },
    isSystem: { type: 'boolean' },
    isActive: { type: 'boolean' },
    version: { type: 'integer' }
  },
  required: ['id', 'code', 'name', 'isSystem', 'isActive', 'version'],
  additionalProperties: false
} as const

export const auditEventsResponseSchema = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          occurredAt: dateTime,
          actor: {
            type: 'object',
            properties: { id: { type: ['integer', 'null'] }, username: { type: ['string', 'null'] } },
            required: ['id', 'username'],
            additionalProperties: false
          },
          action: { type: 'string' },
          outcome: { type: 'string' },
          target: {
            type: ['object', 'null'],
            properties: { type: { type: 'string' }, id: { type: 'string' } },
            required: ['type', 'id'],
            additionalProperties: false
          },
          warehouseId: { type: ['integer', 'null'] },
          requestId: { type: ['string', 'null'] },
          sourceIp: { type: ['string', 'null'] },
          details: { type: 'object', additionalProperties: true }
        },
        required: ['id', 'occurredAt', 'actor', 'action', 'outcome', 'target', 'warehouseId', 'requestId', 'sourceIp', 'details'],
        additionalProperties: false
      }
    },
    nextBefore: { type: ['string', 'null'] }
  },
  required: ['events', 'nextBefore'],
  additionalProperties: false
} as const

export const auditQuerySchema = {
  type: 'object',
  properties: {
    before: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    action: { type: 'string', maxLength: 100 },
    actorUserId: positiveId,
    targetType: { type: 'string', maxLength: 50 },
    targetId: { type: 'string', maxLength: 50 }
  },
  additionalProperties: false
} as const
