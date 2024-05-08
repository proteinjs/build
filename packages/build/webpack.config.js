module.exports = {
  target: 'node', // Ensures that webpack emulates Node.js environment
  entry: './dist/src/runBuildWorkspace.js', // Entry point of your application
  output: {
    path: __dirname, // Output directory
    filename: 'build-workspace.js', // Output file
  },
  module: {
    rules: [
      {
        test: /\.js$/, // Include .js files
        exclude: /node_modules/, // Exclude node_modules from babel-loader
        use: {
          loader: 'babel-loader', // Use babel-loader for transpiling
          options: {
            presets: ['@babel/preset-env'],
          },
        },
      },
      // Add more rules for other file types if needed
    ],
  },
  resolve: {
    extensions: ['.js'], // File extensions to process
  },
};
