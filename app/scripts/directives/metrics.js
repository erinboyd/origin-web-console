'use strict';

angular.module('openshiftConsole')
  .directive('metrics', function($interval,
                                 $parse,
                                 $timeout,
                                 $q,
                                 ChartsService,
                                 MetricsService,
                                 usageValueFilter) {
    return {
      restrict: 'E',
      scope: {
        // Either pod or deployment must be set
        pod: '=?',
        deployment: '=?'
      },
      templateUrl: 'views/directives/metrics.html',
      link: function(scope) {
        var donutByMetric = {}, sparklineByMetric = {};
        var intervalPromise;
        var getMemoryLimit = $parse('resources.limits.memory');
        var getCPULimit = $parse('resources.limits.cpu');

        function bytesToMiB(value) {
          if (!value) {
            return value;
          }

          return value / (1024 * 1024);
        }

        function bytesToKiB(value) {
          if (!value) {
            return value;
          }

          // Round to one decimal place
          return _.round(value / 1024, 1);
        }

        scope.uniqueID = _.uniqueId('metrics-chart-');

        // Metrics to display.
        scope.metrics = [
          {
            label: "Memory",
            units: "MiB",
            chartPrefix: "memory-",
            convert: bytesToMiB,
            containerMetric: true,
            datasets: [
              {
                id: "memory/usage",
                label: "Memory",
                data: []
              }
            ]
          },
          {
            label: "CPU",
            units: "millicores",
            chartPrefix: "cpu-",
            containerMetric: true,
            datasets: [
              {
                id: "cpu/usage",
                label: "CPU",
                data: []
              }
            ]
          },
          {
            label: "Network",
            units: "KiB/s",
            chartPrefix: "network-",
            chartType: "line",
            convert: bytesToKiB,
            datasets: [
              {
                id: "network/tx",
                label: "Sent",
                data: []
              },
              {
                id: "network/rx",
                label: "Received",
                data: []
              }
            ]
          }
        ];

        // Set to true when any data has been loaded (or failed to load).
        scope.loaded = false;

        // Get the URL to show in error messages.
        MetricsService.getMetricsURL().then(function(url) {
          scope.metricsURL = url;
        });

        // Relative time options.
        scope.options = {
          rangeOptions: [{
            label: "Last hour",
            value: 60
          }, {
            label: "Last 4 hours",
            value: 4 * 60
          }, {
            label: "Last day",
            value: 24 * 60
          }, {
            label: "Last 3 days",
            value: 3 * 24 * 60
          }, {
            label: "Last week",
            value: 7 * 24 * 60
          }]
        };
        // Show last hour by default.
        scope.options.timeRange = scope.options.rangeOptions[0];

        scope.usageByMetric = {};

        scope.anyUsageByMetric = function(metric) {
          return _.some(_.map(metric.datasets, 'id'), function(metricID) { return scope.usageByMetric[metricID] !== undefined; });
        };

        var createDonutConfig = function(metric) {
          var chartID = '#' + metric.chartPrefix + scope.uniqueID + '-donut';
          return {
            bindto: chartID,
            onrendered: function() {
              var used = scope.usageByMetric[metric.datasets[0].id].used;
              ChartsService.updateDonutCenterText(chartID, used, metric.units);
            },
            donut: {
              label: {
                show: false
              },
              width: 10
            },
            legend: {
              show: false
            },
            size: {
              height: 175,
              widht: 175
            }
          };
        };

        var createSparklineConfig = function(metric) {
          return {
            bindto: '#' + metric.chartPrefix + scope.uniqueID + '-sparkline',
            axis: {
              x: {
                show: true,
                type: 'timeseries',
                // With default padding you can have negative axis tick values.
                padding: {
                  left: 0,
                  bottom: 0
                },
                tick: {
                  type: 'timeseries',
                  format: '%a %H:%M'
                }
              },
              y: {
                label: metric.units,
                min: 0,
                // With default padding you can have negative axis tick values.
                padding: {
                  left: 0,
                  top: 0,
                  bottom: 0
                },
                show: true,
                tick: {
                  format: function(value) {
                    return d3.round(value, 2);
                  }
                }
              }
            },
            legend: {
              show: metric.datasets.length > 1
            },
            point: {
              show: false
            },
            size: {
              height: 160
            },
            tooltip: {
              format: {
                value: function(value) {
                  return value + " " + metric.units;
                }
              }
            }
          };
        };

        function getLimit(metricID) {
          if (!scope.pod) {
            return null;
          }

          var container = scope.options.selectedContainer;
          switch (metricID) {
          case 'memory/usage':
            var memLimit = getMemoryLimit(container);
            if (memLimit) {
              // Convert to MiB. usageValueFilter returns bytes.
              return bytesToMiB(usageValueFilter(memLimit));
            }
            break;
          case 'cpu/usage':
            var cpuLimit = getCPULimit(container);
            if (cpuLimit) {
              // Convert cores to millicores.
              return usageValueFilter(cpuLimit) * 1000;
            }
            break;
          }

          return null;
        }

        function updateChart(metric) {
          var dates, values = {};

          angular.forEach(metric.datasets, function(dataset) {
            var metricID = dataset.id, metricData = dataset.data;

            dates = ['dates'], values[metricID] = [dataset.label || metricID];

            var usage = scope.usageByMetric[metricID] = {
              total: getLimit(metricID)
            };

            var lastValue = _.last(metricData).value;
            if (isNaN(lastValue)) {
              lastValue = 0;
            }
            if (metric.convert) {
              lastValue = metric.convert(lastValue);
            }

            // Round to the closest whole number for the utilization chart.
            usage.used = d3.round(lastValue);
            if (usage.total) {
              usage.available = Math.max(usage.total - usage.used, 0);
            }

            angular.forEach(metricData, function(point) {
              dates.push(point.start);
              if (point.value === undefined || point.value === null) {
                // Don't attempt to round null values. These appear as gaps in the chart.
                values[metricID].push(point.value);
              } else {
                var value = metric.convert ? metric.convert(point.value) : point.value;
                switch (metricID) {
                  case 'memory/usage':
                  case 'network/rx':
                  case 'network/tx':
                    values[metricID].push(d3.round(value, 2));
                    break;
                  default:
                    values[metricID].push(d3.round(value));
                }
              }
            });

            // Donut
            var donutConfig, donutData;
            if (usage.total) {
              donutData = {
                type: 'donut',
                columns: [
                  ['Used', usage.used],
                  ['Available', usage.available]
                ],
                colors: {
                  Used: "#0088ce",      // Blue
                  Available: "#d1d1d1"  // Gray
                }
              };

              if (!donutByMetric[metricID]) {
                donutConfig = createDonutConfig(metric);
                donutConfig.data = donutData;
                $timeout(function() {
                  donutByMetric[metricID] = c3.generate(donutConfig);
                });
              } else {
                donutByMetric[metricID].load(donutData);
              }
            }
          });

          var columns = [dates].concat(_.values(values));

          // Sparkline
          var sparklineConfig, sparklineData = {
            type: metric.chartType || 'area',
            x: 'dates',
            columns: columns
          };

          var chartId = metric.chartPrefix + "sparkline";

          if (!sparklineByMetric[chartId]) {
            sparklineConfig = createSparklineConfig(metric);
            sparklineConfig.data = sparklineData;
            if (metric.chartDataColors) {
              sparklineConfig.color = { pattern: metric.chartDataColors };
            }
            $timeout(function() {
              sparklineByMetric[chartId] = c3.generate(sparklineConfig);
            });
          } else {
            sparklineByMetric[chartId].load(sparklineData);
          }
        }

        function getTimeRangeMillis() {
          return scope.options.timeRange.value * 60 * 1000;
        }

        function getConfig(metric, dataset, start) {
          var lastPoint;
          var config = {
            metric: dataset.id,
            bucketDuration: Math.floor(getTimeRangeMillis() / 60) + "ms"
          };

          // Leave the end time off to use the server's current time as the
          // end time. This prevents an issue where the donut chart shows 0
          // for current usage if the client clock is ahead of the server
          // clock.
          if (dataset.data && dataset.data.length) {
            lastPoint = _.last(dataset.data);
            config.start = lastPoint.end;
          } else {
            config.start = start;
          }

          if (scope.pod) {
            return _.assign(config, {
              namespace: scope.pod.metadata.namespace,
              pod: scope.pod,
              containerName: metric.containerMetric ? scope.options.selectedContainer.name : "pod"
            });
          }

          if (scope.deployment) {
            return _.assign(config, {
              namespace: scope.deployment.metadata.namespace,
              deployment: scope.deployment.metadata.name
            });
          }

          return null;
        }

        // Make sure there are no errors or missing data before updating.
        function canUpdate() {
          if (scope.metricsError) {
            return false;
          }

          if (scope.deployment) {
            return true;
          }

          return scope.pod && _.get(scope, 'options.selectedContainer');
        }

        function updateData(start, dataset, response) {
          // Throw out the last data point, which is a partial bucket.
          var newData = _.initial(response.data);
          if (!dataset.data) {
            dataset.data = newData;
            return;
          }

          dataset.data =
            _.chain(dataset.data)
            // Make sure we're only showing points that are still in the time range.
            .takeRightWhile(function(point) {
              return point.start >= start;
            })
            // Add the new values.
            .concat(newData)
            .value();
        }

        function update() {
          if (!canUpdate()) {
            return;
          }

          var start = Date.now() - getTimeRangeMillis();

          angular.forEach(scope.metrics, function(metric) {
            var promises = [];

            // On metrics that require more than one set of data (e.g. network
            // incoming and outgoing traffic) we perform one request for each,
            // but collect and handle all requests in one single promise below.
            // It's important that every metric uses the same 'start' timestamp
            // and number of buckets, so that the returned data for every metric
            // fit in the same collection of 'dates' and can be displayed in
            // exactly the same point in time in the graph.
            angular.forEach(metric.datasets, function(dataset) {
              var config = getConfig(metric, dataset, start);
              if (!config) {
                return;
              }
              promises.push(MetricsService.get(config));
            });

            // Collect all promises from every metric requested into one, so we
            // have all data the chart wants at the time of the chart creation
            // (or timeout updates, etc).
            $q.all(promises).then(
              // success
              function(responses) {
                angular.forEach(responses, function(response) {
                  var dataset = _.find(metric.datasets, {
                    id: response.metricID
                  });
                  updateData(start, dataset, response);
                });
                updateChart(metric);
              },
              // failure
              function(responses) {
                angular.forEach(responses, function(response) {
                  scope.metricsError = {
                    status: response.status,
                    details: _.get(response, 'data.errorMsg') || response.statusText || "Status code " + response.status
                  };
                });
              }
            ).finally(function() {
              // Even on errors mark metrics as loaded to replace the
              // "Loading..." message with "No metrics to display."
              scope.loaded = true;
            });
          });
        }

        // Updates immediately and then on options changes.
        scope.$watch('options', function() {
          // Remove any existing data so that we request data for the new container or time range.
          _.each(scope.metrics, function(metric) {
            _.each(metric.datasets, function(dataset) {
              delete dataset.data;
            });
          });
          delete scope.metricsError;
          update();
        }, true);
        // Also update every 30 seconds.
        intervalPromise = $interval(update, 30 * 1000, false);

        scope.$on('$destroy', function() {
          if (intervalPromise) {
            $interval.cancel(intervalPromise);
            intervalPromise = null;
          }

          angular.forEach(donutByMetric, function(chart) {
            chart.destroy();
          });
          donutByMetric = null;

          angular.forEach(sparklineByMetric, function(chart) {
            chart.destroy();
          });
          sparklineByMetric = null;
        });
      }
    };
  });
