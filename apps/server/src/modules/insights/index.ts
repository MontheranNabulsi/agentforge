/** Public API of the insights module: read-only, cross-module reporting. */
export { InsightsQueries, type InsightsReadModel } from './application/insights-queries';
export { SqlInsightsReadModel } from './infrastructure/sql-insights-read-model';
export { insightsRoutes } from './presentation/http/insights-routes';
export { SqlProjectData, type ProjectQuery } from './infrastructure/sql-project-data';
