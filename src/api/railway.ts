const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';

interface RailwayResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface ServiceRecord {
  id: string;
  name: string;
  icon: string;
  createdAt: string;
  projectId: string;
}

export interface DeploymentConfig {
  name: string;
  projectId: string;
  serviceId: string;
  environmentId?: string;
  repo?: string;
  branch?: string;
}

export class RailwayClient {
  constructor(private readonly token: string) {}

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    const result = await response.json() as RailwayResponse<T>;

    if (result.errors && result.errors.length > 0) {
      throw new Error(result.errors[0].message);
    }

    if (!result.data) {
      throw new Error('No data returned from Railway API');
    }

    return result.data;
  }

  async getService(serviceId: string): Promise<ServiceRecord> {
    const query = `
      query service($id: String!) {
        service(id: $id) {
          id
          name
          icon
          createdAt
          projectId
        }
      }
    `;
    const result = await this.query<{ service: ServiceRecord }>(query, { id: serviceId });
    return result.service;
  }

  async getServiceInstance(serviceId: string, environmentId: string): Promise<unknown> {
    const query = `
      query serviceInstance($serviceId: String!, $environmentId: String!) {
        serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
          id
          serviceName
          startCommand
          buildCommand
          rootDirectory
          healthcheckPath
          region
          numReplicas
          restartPolicyType
          restartPolicyMaxRetries
          latestDeployment { id status createdAt }
        }
      }
    `;
    const result = await this.query<{ serviceInstance: unknown }>(query, { serviceId, environmentId });
    return result.serviceInstance;
  }

  async connectService(serviceId: string, repo: string, branch: string): Promise<string> {
    const query = `
      mutation serviceConnect($id: String!, $input: ServiceConnectInput!) {
        serviceConnect(id: $id, input: $input) {
          id
        }
      }
    `;
    const result = await this.query<{ serviceConnect: { id: string } }>(query, {
      id: serviceId,
      input: { repo, branch },
    });
    return result.serviceConnect.id;
  }

  async disconnectService(serviceId: string): Promise<string> {
    const query = `
      mutation serviceDisconnect($id: String!) {
        serviceDisconnect(id: $id) {
          id
        }
      }
    `;
    const result = await this.query<{ serviceDisconnect: { id: string } }>(query, { id: serviceId });
    return result.serviceDisconnect.id;
  }

  async deployService(serviceId: string, environmentId: string): Promise<string> {
    const query = `
      mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
        serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
      }
    `;
    const result = await this.query<{ serviceInstanceDeployV2: string }>(query, { serviceId, environmentId });
    return result.serviceInstanceDeployV2;
  }

  async redeployService(serviceId: string, environmentId: string): Promise<string> {
    const query = `
      mutation serviceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
        serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
      }
    `;
    const result = await this.query<{ serviceInstanceRedeploy: string }>(query, { serviceId, environmentId });
    return result.serviceInstanceRedeploy;
  }

  async getVariables(projectId: string, environmentId: string, serviceId?: string): Promise<Record<string, string>> {
    const query = `
      query variables($projectId: String!, $environmentId: String!, $serviceId: String) {
        variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
      }
    `;
    const result = await this.query<{ variables: Record<string, string> }>(
      query,
      { projectId, environmentId, serviceId }
    );
    return result.variables;
  }

  async upsertVariable(input: {
    projectId: string;
    environmentId: string;
    serviceId?: string;
    name: string;
    value: string;
  }): Promise<boolean> {
    const query = `
      mutation variableUpsert($input: VariableUpsertInput!) {
        variableUpsert(input: $input)
      }
    `;
    const result = await this.query<{ variableUpsert: boolean }>(query, { input });
    return result.variableUpsert;
  }

  async bulkUpsertVariables(input: {
    projectId: string;
    environmentId: string;
    serviceId?: string;
    variables: Record<string, string>;
  }): Promise<boolean> {
    const query = `
      mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }
    `;
    const result = await this.query<{ variableCollectionUpsert: boolean }>(query, { input });
    return result.variableCollectionUpsert;
  }

  async deleteVariable(input: {
    projectId: string;
    environmentId: string;
    serviceId?: string;
    name: string;
  }): Promise<boolean> {
    const query = `
      mutation variableDelete($input: VariableDeleteInput!) {
        variableDelete(input: $input)
      }
    `;
    const result = await this.query<{ variableDelete: boolean }>(query, { input });
    return result.variableDelete;
  }

  async addCustomDomain(serviceId: string, domain: string): Promise<string> {
    const query = `
      mutation serviceInstanceAddDomain($serviceId: String!, $domain: String!) {
        serviceInstanceAddDomain(serviceId: $serviceId, domain: $domain) {
          id
        }
      }
    `;
    const result = await this.query<{ serviceInstanceAddDomain: { id: string } }>(query, { serviceId, domain });
    return result.serviceInstanceAddDomain.id;
  }
}

export async function deployToRailway(token: string, config: DeploymentConfig): Promise<string> {
  const client = new RailwayClient(token);

  if (config.repo && config.branch) {
    await client.connectService(config.serviceId, config.repo, config.branch);
  }

  const environmentId = config.environmentId || 'production';
  return client.deployService(config.serviceId, environmentId);
}

export async function redeployToRailway(token: string, serviceId: string, environmentId?: string): Promise<string> {
  const client = new RailwayClient(token);
  const envId = environmentId || 'production';
  return client.redeployService(serviceId, envId);
}

export async function changeBranch(token: string, serviceId: string, repo: string, branch: string): Promise<void> {
  const client = new RailwayClient(token);
  await client.connectService(serviceId, repo, branch);
}

export async function addCustomDomain(token: string, serviceId: string, domain: string): Promise<void> {
  const client = new RailwayClient(token);
  await client.addCustomDomain(serviceId, domain);
}
