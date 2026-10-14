module gated_client(input wire request, grant, input wire [7:0] din,
                    output wire req, output wire [7:0] selected);
  assign req = request;
  assign selected = grant ? din : 8'b0;
endmodule
module priority_grant(input wire req_a, req_b, output wire grant_a, grant_b);
  assign grant_a = req_a;
  assign grant_b = ~req_a & req_b;
endmodule
module merge_or(input wire [7:0] a, b, output wire [7:0] dout);
  assign dout = a | b;
endmodule
module arbiter(input wire req_a, req_b, input wire [7:0] a, b, output wire [7:0] dout);
  wire ra, rb, ga, gb;
  wire [7:0] da, db;
  gated_client client_a(req_a, ga, a, ra, da);
  gated_client client_b(req_b, gb, b, rb, db);
  priority_grant choose(ra, rb, ga, gb);
  merge_or merge(da, db, dout);
endmodule
