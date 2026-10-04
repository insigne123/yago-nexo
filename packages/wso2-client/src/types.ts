/** Tipos mínimos de las REST API de WSO2 API Manager 4.x que usa Nexo. */

export interface ApiSummary {
  id: string;
  name: string;
  version: string;
  context: string;
  type?: string;
  lifeCycleStatus?: string;
  provider?: string;
  description?: string;
  visibility?: string;
  additionalProperties?: Array<{ name: string; value: string; display: boolean }>;
  additionalPropertiesMap?: Record<string, { name: string; value: string; display: boolean }>;
  businessInformation?: {
    businessOwner?: string;
    businessOwnerEmail?: string;
    technicalOwner?: string;
    technicalOwnerEmail?: string;
  };
  securityScheme?: string[];
  createdTime?: string;
  updatedTime?: string;
}

export interface ApiList {
  count: number;
  list: ApiSummary[];
  pagination?: { offset: number; limit: number; total: number };
}

export interface ApiRevision {
  id: string;
  displayName?: string;
  description?: string;
  createdTime?: number;
  deploymentInfo?: Array<{ name: string; vhost?: string; status?: string }>;
}

export interface Application {
  applicationId: string;
  name: string;
  throttlingPolicy?: string;
  description?: string;
  status?: string;
  owner?: string;
  subscriptionCount?: number;
}

export interface ApplicationKey {
  keyMappingId?: string;
  keyManager?: string;
  consumerKey?: string;
  consumerSecret?: string;
  keyType?: string;
  supportedGrantTypes?: string[];
  keyState?: string;
}

export interface Subscription {
  subscriptionId: string;
  applicationId: string;
  apiId?: string;
  throttlingPolicy?: string;
  status?: string;
  applicationInfo?: { applicationId: string; name: string; subscriber?: string };
  apiInfo?: { id: string; name: string; version: string };
}

export interface KeyManager {
  id: string;
  name: string;
  type: string;
  enabled?: boolean;
  issuer?: string;
}

export type DenyPolicyType = "API" | "APPLICATION" | "IP" | "IPRANGE" | "USER" | "SUBSCRIPTION";

export interface DenyPolicy {
  conditionId: string;
  conditionType: DenyPolicyType;
  conditionValue: unknown;
  conditionStatus: boolean;
}

export interface WorkflowInfo {
  workflowType: string;
  workflowStatus: string;
  createdTime?: string;
  referenceId: string;
  properties?: Record<string, unknown>;
  description?: string;
}

export interface WorkflowList {
  count: number;
  list: WorkflowInfo[];
}
