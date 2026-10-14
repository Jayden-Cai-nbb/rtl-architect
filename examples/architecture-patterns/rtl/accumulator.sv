module accumulator(input wire clk, rst, enable, input wire [7:0] din, output logic [7:0] q);
  wire [7:0] sum = q + din;
  always_ff @(posedge clk) if (rst) q <= '0; else if (enable) q <= sum;
endmodule
