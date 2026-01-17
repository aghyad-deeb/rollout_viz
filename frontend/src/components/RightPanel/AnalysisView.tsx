import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { Sample } from '../../types';

interface AnalysisViewProps {
  samples: Sample[];
  isDarkMode: boolean;
}

// Color palette from the app
const COLORS = ['#2a9d8f', '#e9c46a', '#f4a261', '#e76f51', '#264653', '#8ab17d', '#babb74', '#efb366'];

export function AnalysisView({ samples, isDarkMode }: AnalysisViewProps) {
  // Summary statistics
  const stats = useMemo(() => {
    if (samples.length === 0) {
      return {
        totalSamples: 0,
        avgReward: 0,
        minReward: 0,
        maxReward: 0,
        uniqueDataSources: 0,
        minStep: 0,
        maxStep: 0,
      };
    }

    const rewards = samples.map(s => s.attributes.reward);
    const steps = samples.map(s => s.attributes.step);
    const dataSources = new Set(samples.map(s => s.attributes.data_source));

    return {
      totalSamples: samples.length,
      avgReward: rewards.reduce((a, b) => a + b, 0) / rewards.length,
      minReward: Math.min(...rewards),
      maxReward: Math.max(...rewards),
      uniqueDataSources: dataSources.size,
      minStep: Math.min(...steps),
      maxStep: Math.max(...steps),
    };
  }, [samples]);

  // Reward distribution histogram
  const rewardHistogram = useMemo(() => {
    if (samples.length === 0) return [];

    const rewards = samples.map(s => s.attributes.reward);
    const min = Math.min(...rewards);
    const max = Math.max(...rewards);
    
    // Handle case where all rewards are the same
    if (min === max) {
      return [{ range: min.toFixed(2), count: samples.length }];
    }

    const binCount = Math.min(15, samples.length);
    const binSize = (max - min) / binCount;
    const bins: { range: string; count: number; min: number; max: number }[] = [];

    for (let i = 0; i < binCount; i++) {
      const binMin = min + i * binSize;
      const binMax = min + (i + 1) * binSize;
      bins.push({
        range: `${binMin.toFixed(1)}`,
        count: 0,
        min: binMin,
        max: binMax,
      });
    }

    rewards.forEach(reward => {
      const binIndex = Math.min(Math.floor((reward - min) / binSize), binCount - 1);
      bins[binIndex].count++;
    });

    return bins;
  }, [samples]);

  // Reward by step
  const rewardByStep = useMemo(() => {
    if (samples.length === 0) return [];

    const grouped: Record<number, { sum: number; count: number }> = {};
    samples.forEach(s => {
      const step = s.attributes.step;
      if (!grouped[step]) {
        grouped[step] = { sum: 0, count: 0 };
      }
      grouped[step].sum += s.attributes.reward;
      grouped[step].count++;
    });

    return Object.entries(grouped)
      .map(([step, data]) => ({
        step: parseInt(step),
        avgReward: data.sum / data.count,
        count: data.count,
      }))
      .sort((a, b) => a.step - b.step);
  }, [samples]);

  // Data source breakdown
  const dataSourceBreakdown = useMemo(() => {
    if (samples.length === 0) return [];

    const grouped: Record<string, number> = {};
    samples.forEach(s => {
      const source = s.attributes.data_source;
      grouped[source] = (grouped[source] || 0) + 1;
    });

    return Object.entries(grouped)
      .map(([name, count]) => ({
        name: name.split('/').pop() || name, // Show last part of path
        fullName: name,
        count,
      }))
      .sort((a, b) => b.count - a.count);
  }, [samples]);

  // Reward by data source
  const rewardBySource = useMemo(() => {
    if (samples.length === 0) return [];

    const grouped: Record<string, { sum: number; count: number }> = {};
    samples.forEach(s => {
      const source = s.attributes.data_source;
      if (!grouped[source]) {
        grouped[source] = { sum: 0, count: 0 };
      }
      grouped[source].sum += s.attributes.reward;
      grouped[source].count++;
    });

    return Object.entries(grouped)
      .map(([name, data]) => ({
        name: name.split('/').pop() || name,
        fullName: name,
        avgReward: data.sum / data.count,
        count: data.count,
      }))
      .sort((a, b) => b.avgReward - a.avgReward);
  }, [samples]);

  const textColor = isDarkMode ? '#e5e7eb' : '#374151';
  const gridColor = isDarkMode ? '#374151' : '#e5e7eb';
  const bgCard = isDarkMode ? 'bg-gray-800' : 'bg-gray-50';
  const borderColor = isDarkMode ? 'border-gray-700' : 'border-gray-200';

  if (samples.length === 0) {
    return (
      <div className={`h-full flex items-center justify-center ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
        <div className="text-center">
          <span className="material-symbols-outlined" style={{ fontSize: 48 }}>analytics</span>
          <p className="mt-2">No samples to analyze</p>
          <p className="text-sm">Load a file or adjust filters</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full overflow-auto p-4 ${isDarkMode ? 'bg-[#1a1a2e]' : 'bg-white'}`}>
      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className={`p-4 rounded-lg border ${bgCard} ${borderColor}`}>
          <div className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Total Samples</div>
          <div className={`text-2xl font-bold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
            {stats.totalSamples.toLocaleString()}
          </div>
        </div>
        <div className={`p-4 rounded-lg border ${bgCard} ${borderColor}`}>
          <div className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Average Reward</div>
          <div className={`text-2xl font-bold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
            {stats.avgReward.toFixed(2)}
          </div>
          <div className={`text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
            {stats.minReward.toFixed(2)} to {stats.maxReward.toFixed(2)}
          </div>
        </div>
        <div className={`p-4 rounded-lg border ${bgCard} ${borderColor}`}>
          <div className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Data Sources</div>
          <div className={`text-2xl font-bold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
            {stats.uniqueDataSources}
          </div>
        </div>
        <div className={`p-4 rounded-lg border ${bgCard} ${borderColor}`}>
          <div className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Step Range</div>
          <div className={`text-2xl font-bold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
            {stats.minStep} - {stats.maxStep}
          </div>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-2 gap-4">
        {/* Reward Distribution */}
        <div className={`p-4 rounded-lg border ${bgCard} ${borderColor}`}>
          <h3 className={`text-sm font-medium mb-3 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
            Reward Distribution
          </h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={rewardHistogram}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis 
                dataKey="range" 
                tick={{ fill: textColor, fontSize: 11 }}
                angle={-45}
                textAnchor="end"
                height={60}
              />
              <YAxis tick={{ fill: textColor, fontSize: 11 }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: isDarkMode ? '#1f2937' : '#fff',
                  border: `1px solid ${gridColor}`,
                  color: textColor,
                }}
                formatter={(value) => [value ?? 0, 'Count']}
              />
              <Bar dataKey="count" fill="#2a9d8f" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Reward by Step */}
        <div className={`p-4 rounded-lg border ${bgCard} ${borderColor}`}>
          <h3 className={`text-sm font-medium mb-3 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
            Average Reward by Step
          </h3>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={rewardByStep}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis 
                dataKey="step" 
                tick={{ fill: textColor, fontSize: 11 }}
              />
              <YAxis tick={{ fill: textColor, fontSize: 11 }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: isDarkMode ? '#1f2937' : '#fff',
                  border: `1px solid ${gridColor}`,
                  color: textColor,
                }}
                formatter={(value, name) => [
                  name === 'avgReward' ? (value as number).toFixed(3) : value,
                  name === 'avgReward' ? 'Avg Reward' : 'Count'
                ]}
              />
              <Line 
                type="monotone" 
                dataKey="avgReward" 
                stroke="#e9c46a" 
                strokeWidth={2}
                dot={{ fill: '#e9c46a', strokeWidth: 0 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Data Source Breakdown (Pie) */}
        <div className={`p-4 rounded-lg border ${bgCard} ${borderColor}`}>
          <h3 className={`text-sm font-medium mb-3 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
            Data Source Distribution
          </h3>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={dataSourceBreakdown.slice(0, 8)} // Limit to top 8
                dataKey="count"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={80}
                label={({ name, percent }) => `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`}
                labelLine={{ stroke: textColor }}
              >
                {dataSourceBreakdown.slice(0, 8).map((_, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: isDarkMode ? '#1f2937' : '#fff',
                  border: `1px solid ${gridColor}`,
                  color: textColor,
                }}
                formatter={(value, _name, props) => [
                  `${value} samples`,
                  (props.payload as { fullName: string }).fullName
                ]}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Reward by Data Source (Bar) */}
        <div className={`p-4 rounded-lg border ${bgCard} ${borderColor}`}>
          <h3 className={`text-sm font-medium mb-3 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
            Average Reward by Data Source
          </h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart 
              data={rewardBySource.slice(0, 10)} // Limit to top 10
              layout="vertical"
            >
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis type="number" tick={{ fill: textColor, fontSize: 11 }} />
              <YAxis 
                type="category" 
                dataKey="name" 
                tick={{ fill: textColor, fontSize: 10 }}
                width={100}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: isDarkMode ? '#1f2937' : '#fff',
                  border: `1px solid ${gridColor}`,
                  color: textColor,
                }}
                formatter={(value, name, props) => {
                  const payload = props.payload as { fullName: string; count: number };
                  return [
                    name === 'avgReward' ? `${(value as number).toFixed(3)} (${payload.count} samples)` : value,
                    payload.fullName
                  ];
                }}
              />
              <Legend />
              <Bar 
                dataKey="avgReward" 
                fill="#f4a261" 
                name="Avg Reward"
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
