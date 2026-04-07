const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.app/graphql/v2';

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

export interface ProjectServiceRecord {
  id: string;
  name: string;
}

export interface ProjectEnvironmentRecord {
  id: string;
  name: string;
}

export interface ProjectContextRecord {
  id: string;
  baseEnvironmentId: string | null;
  services: ProjectServiceRecord[];
  environments: ProjectEnvironmentRecord[];
}

export interface ServiceInstanceRecord {
  id: string;
  serviceId: string;
  serviceName: string;
  startCommand: string | null;
  buildCommand: string | null;
  rootDirectory: string | null;
  healthcheckPath: string | null;
  region: string | null;
  numReplicas: number | null;
  restartPolicyType: string | null;
  restartPolicyMaxRetries: number | null;
  latestDeployment: {
    id: string;
    status: string;
    createdAt: string;
  } | null;
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

  private async executeQuery<T>(
    query: string,
    variables: Record<string, unknown>,
    headers: Record<string, string>
  ): Promise<T> {
    const response = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
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

  private isAuthError(error: unknown): boolean {
    return error instanceof Error
      && (error.message === 'Not Authorized' || error.message.toLowerCase().includes('unauthorized'));
  }

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.executeQuery<T>(query, variables, {
        Authorization: `Bearer ${this.token}`,
      });
    } catch (error) {
      if (!this.isAuthError(error)) {
        throw error;
      }

      return this.executeQuery<T>(query, variables, {
        'Project-Access-Token': this.token,
      });
    }
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

  async getProjectServices(projectId: string): Promise<ProjectServiceRecord[]> {
    const query = `
      query project($id: String!) {
        project(id: $id) {
          services(first: 100) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    `;
    const result = await this.query<{
      project: {
        services: {
          edges: Array<{ node: ProjectServiceRecord }>;
        };
      } | null;
    }>(query, { id: projectId });
    if (!result.project) {
      throw new Error(`Project ${projectId} not found`);
    }

    return result.project.services.edges.map((edge) => edge.node);
  }

  async getProjectContext(projectId: string): Promise<ProjectContextRecord> {
    const query = `
      query project($id: String!) {
        project(id: $id) {
          id
          baseEnvironmentId
          environments(first: 100) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    `;
    const result = await this.query<{
      project: {
        id: string;
        baseEnvironmentId: string | null;
        environments: {
          edges: Array<{ node: ProjectEnvironmentRecord }>;
        };
      } | null;
    }>(query, { id: projectId });
    if (!result.project) {
      throw new Error(`Project ${projectId} not found`);
    }

    let services: ProjectServiceRecord[] = [];
    try {
      services = await this.getProjectServices(projectId);
    } catch (error) {
      if (!result.project.baseEnvironmentId) {
        throw error;
      }

      const instances = await this.getEnvironmentServiceInstances(result.project.baseEnvironmentId);
      services = instances.map((instance) => ({
        id: instance.serviceId,
        name: instance.serviceName,
      }));
    }

    return {
      id: result.project.id,
      baseEnvironmentId: result.project.baseEnvironmentId,
      services,
      environments: result.project.environments.edges.map((edge) => edge.node),
    };
  }

  async getEnvironmentServiceInstances(environmentId: string): Promise<ServiceInstanceRecord[]> {
    const query = `
      query environment($id: String!) {
        environment(id: $id) {
          serviceInstances {
            edges {
              node {
                id
                serviceId
                serviceName
                startCommand
                buildCommand
                rootDirectory
                healthcheckPath
                region
                numReplicas
                restartPolicyType
                restartPolicyMaxRetries
                latestDeployment {
                  id
                  status
                  createdAt
                }
              }
            }
          }
        }
      }
    `;
    const result = await this.query<{
      environment: {
        serviceInstances: {
          edges: Array<{ node: ServiceInstanceRecord }>;
        };
      } | null;
    }>(query, { id: environmentId });

    if (!result.environment) {
      throw new Error(`Environment ${environmentId} not found`);
    }

    return result.environment.serviceInstances.edges.map((edge) => edge.node);
  }

  async getServiceInstance(serviceId: string, environmentId: string): Promise<ServiceInstanceRecord | null> {
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
    const result = await this.query<{ serviceInstance: ServiceInstanceRecord | null }>(query, { serviceId, environmentId });
    return result.serviceInstance;
  }

  async updateServiceInstance(
    serviceId: string,
    environmentId: string,
    input: { rootDirectory?: string }
  ): Promise<boolean> {
    const query = `
      mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
        serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
      }
    `;
    const result = await this.query<{ serviceInstanceUpdate: boolean }>(query, {
      serviceId,
      environmentId,
      input,
    });
    return result.serviceInstanceUpdate;
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

export async function updateRootDirectory(
  token: string,
  serviceId: string,
  environmentId: string,
  rootDirectory: string
): Promise<void> {
  const client = new RailwayClient(token);
  await client.updateServiceInstance(serviceId, environmentId, { rootDirectory });
}
