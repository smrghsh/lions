export default [
  {
    name: "starTexture",
    type: "texture",
    path: "textures/5.png",
  },
  {
    name: "skyTexture",
    type: "exr",
    path: "textures/skyTexture.exr",
  },
  {
    name: "font",
    type: "font",
    path: "helvetiker_regular.typeface.json",
  },
  // Processed GPS collar fixes for puma 164M, written by
  // Raw_Data_Processing_Scripts/processdata.py. One entry per chunk file;
  // World.loadLionPaths() lists the same names.
  {
    name: "164M-4hr-A",
    type: "simulationData",
    path: "164M-4hr-A.csv",
  },
  {
    name: "164M-5min-A",
    type: "simulationData",
    path: "164M-5min-A.csv",
  },
];
